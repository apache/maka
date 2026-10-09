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

//! The Appearance page, in Maka Desktop's order
//! (appearance-settings-page.tsx): the theme, as three cards (Light, Dark,
//! Follow system), each with a small picture of the window in it
//! (`ThemePreviewMock`, styles/settings/theme-preview.css); the color
//! palette, as Desktop's eleven palettes in its two groups; the UI font
//! size; the app icon ([`AppIconSection`]); and the custom pets
//! ([`PetSection`]).
//!
//! Desktop's terminal font size and Workbar switch are left out (this
//! client has no terminal and no Workbar).

use gpui_kit::base::{Button as StepButton, Decrement, Increment};
use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{
    ActiveTheme as _, Icon, IconName, Sizable as _, Size, StyleSized as _, StyledExt as _,
    ThemeMode, ThemeStyled as _, h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Role, ScrollAnchor, ScrollHandle,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, TextAlign,
    Window, div, prelude::FluentBuilder as _, px, relative, rems,
};
use shared::copy::Text;
use shared::copy::settings as copy;
use shared::domain_element_id;
use shared::palette::ThemePalette;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, MakaPalette, RADIUS_CONTROL, segment, segmented_track,
};

use workspace::HostSession;

use crate::app_icon_section::AppIconSection;
use crate::page_kit::selectable_card;
use crate::pet_section::PetSection;
use crate::preferences::{
    AppPreferences, Appearance, FontSizeStep, NarrowSidebar, UI_FONT_SIZES, choose_appearance,
    choose_narrow_sidebar, choose_palette, choose_ui_font_size, step_ui_font_size,
};
use crate::rows::{SettingsGroup, SettingsRow};

/// gpui-kit's key context for a number field, whose Up and Down bindings
/// dispatch [`Increment`] and [`Decrement`].
const NUMBER_INPUT_CONTEXT: &str = "NumberInput";

/// The cards in Desktop's order.
const THEMES: [Appearance; 3] = [Appearance::Light, Appearance::Dark, Appearance::System];

/// Height of a theme card's picture: Desktop's 16:7 at the page's card width.
const PREVIEW_HEIGHT_REMS: f32 = 6.;

/// The palette groups, in Desktop's order (`PALETTE_GROUPS`): the default and
/// the four community editor themes, then the six product colours.
const PALETTE_GROUPS: [(&str, Text, &[ThemePalette]); 2] = [
    (
        "editor",
        copy::PALETTE_GROUP_EDITOR,
        &[
            ThemePalette::Default,
            ThemePalette::OneDark,
            ThemePalette::CatppuccinMocha,
            ThemePalette::TokyoNight,
            ThemePalette::Nord,
        ],
    ),
    (
        "product",
        copy::PALETTE_GROUP_PRODUCT,
        &[
            ThemePalette::Coral,
            ThemePalette::Azure,
            ThemePalette::Forest,
            ThemePalette::Dusk,
            ThemePalette::Sand,
            ThemePalette::Mono,
        ],
    ),
];

/// Desktop's card grid (`columns={{ minWidth: 180 }}`) at the page's width.
const PALETTE_COLUMNS: u16 = 4;

/// A palette swatch: Desktop's 32px disc.
const SWATCH_REMS: f32 = 2.;

fn help(appearance: Appearance) -> Text {
    match appearance {
        Appearance::Light => copy::THEME_LIGHT_HELP,
        Appearance::Dark => copy::THEME_DARK_HELP,
        _ => copy::THEME_SYSTEM_HELP,
    }
}

/// A palette's name and line (Desktop's `paletteLabels`, `paletteHelp`).
pub(crate) fn palette_copy(palette: ThemePalette) -> (Text, Text) {
    match palette {
        ThemePalette::Default => (copy::PALETTE_DEFAULT, copy::PALETTE_DEFAULT_HELP),
        ThemePalette::OneDark => (copy::PALETTE_ONEDARK, copy::PALETTE_ONEDARK_HELP),
        ThemePalette::CatppuccinMocha => (copy::PALETTE_CATPPUCCIN, copy::PALETTE_CATPPUCCIN_HELP),
        ThemePalette::TokyoNight => (copy::PALETTE_TOKYO_NIGHT, copy::PALETTE_TOKYO_NIGHT_HELP),
        ThemePalette::Nord => (copy::PALETTE_NORD, copy::PALETTE_NORD_HELP),
        ThemePalette::Coral => (copy::PALETTE_CORAL, copy::PALETTE_CORAL_HELP),
        ThemePalette::Azure => (copy::PALETTE_AZURE, copy::PALETTE_AZURE_HELP),
        ThemePalette::Forest => (copy::PALETTE_FOREST, copy::PALETTE_FOREST_HELP),
        ThemePalette::Dusk => (copy::PALETTE_DUSK, copy::PALETTE_DUSK_HELP),
        ThemePalette::Sand => (copy::PALETTE_SAND, copy::PALETTE_SAND_HELP),
        ThemePalette::Mono => (copy::PALETTE_MONO, copy::PALETTE_MONO_HELP),
    }
}

/// Behavior and presentation owner of the Appearance page. A card or a
/// font size applies at once, as the footer menu does, and is saved in the
/// client's preferences; the chosen card carries the accent ring and reads
/// as pressed (Desktop's `SelectableCard`).
pub struct AppearancePage {
    font_size: Entity<InputState>,
    /// The size the field last took from the preferences.
    shown_size: u8,
    app_icon: Entity<AppIconSection>,
    pets: Entity<PetSection>,
    /// Where the page scrolls to for `--open-settings appearance:app-icon`
    /// and `appearance:pets` (`appearance:app-icon-end` is the App icon
    /// section's [`AppIconSection::scroll_to_end`]).
    font_size_anchor: ScrollAnchor,
    app_icon_anchor: ScrollAnchor,
    pets_anchor: ScrollAnchor,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for AppearancePage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppearancePage").finish_non_exhaustive()
    }
}

impl AppearancePage {
    /// The page over `host`'s State Root (its pet library), in the
    /// settings page that `page_scroll` scrolls.
    pub fn new(
        host: &Entity<HostSession>,
        page_scroll: &ScrollHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let size = AppPreferences::current(cx).ui_font_size;
        let font_size = cx.new(|cx| {
            let mut field = InputState::new(window, cx)
                .step(1.)
                .min(f64::from(*UI_FONT_SIZES.start()))
                .max(f64::from(*UI_FONT_SIZES.end()))
                .default_value(size.to_string());
            // Digits only, and clamped into the range when left, as the
            // kit's `NumberInput` sets it up.
            field.ensure_number_mask();
            field
        });
        let preferences = AppPreferences::global(cx);
        let app_icon = cx.new(|cx| AppIconSection::new(cx).with_page_scroll(page_scroll.clone()));
        let pets = cx.new(|cx| PetSection::new(host, cx));
        let subscriptions = vec![
            cx.observe(&app_icon, |_, _, cx| cx.notify()),
            cx.observe(&pets, |_, _, cx| cx.notify()),
            cx.subscribe(&font_size, |_, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    // A size in range applies as it is typed or stepped; the
                    // field clamps the rest when it is left.
                    let size = input.read(cx).value().trim().parse::<u8>().ok();
                    if let Some(size) = size.filter(|size| UI_FONT_SIZES.contains(size)) {
                        choose_ui_font_size(size, cx);
                    }
                }
            }),
            // A size set elsewhere (a step, View › Zoom In) shows here at
            // once. While the field is being typed in, only a new size
            // replaces what is typed: another preference changing leaves
            // a half-typed one alone.
            cx.observe_in(&preferences, window, |this, _, window, cx| {
                let size = AppPreferences::current(cx).ui_font_size;
                let field = this.font_size.read(cx);
                let typed = field.value().trim().parse::<u8>().ok();
                let editing = field.focus_handle(cx).is_focused(window);
                if typed != Some(size) && (size != this.shown_size || !editing) {
                    let size = size.to_string();
                    this.font_size.update(cx, |input, cx| input.set_value(size, window, cx));
                }
                this.shown_size = size;
                cx.notify();
            }),
        ];
        Self {
            font_size,
            shown_size: size,
            app_icon,
            pets,
            font_size_anchor: ScrollAnchor::for_handle(page_scroll.clone()),
            app_icon_anchor: ScrollAnchor::for_handle(page_scroll.clone()),
            pets_anchor: ScrollAnchor::for_handle(page_scroll.clone()),
            _subscriptions: subscriptions,
        }
    }

    /// The UI font size field.
    pub fn font_size(&self) -> &Entity<InputState> {
        &self.font_size
    }

    pub fn app_icon(&self) -> &Entity<AppIconSection> {
        &self.app_icon
    }

    pub fn pets(&self) -> &Entity<PetSection> {
        &self.pets
    }

    /// Scrolls the page to the Font size section (`font-size`), the App
    /// icon section (`app-icon`), its last group of icons (`app-icon-end`)
    /// or the Custom pets section (`pets`), for screenshots; `false` for
    /// anything else.
    /// It waits a frame first, so a page just opened has been laid out
    /// and the anchor knows where its section is.
    pub fn reveal(&self, target: &str, window: &mut Window, _: &mut App) -> bool {
        let anchor = match target {
            "font-size" => self.font_size_anchor.clone(),
            "app-icon" => self.app_icon_anchor.clone(),
            "app-icon-end" => {
                // Two frames, as an anchor takes: the page laid out, then
                // where its groups landed.
                let section = self.app_icon.downgrade();
                window.on_next_frame(move |window, _| {
                    window.on_next_frame(move |window, cx| {
                        section.update(cx, |section, _| section.scroll_to_end()).ok();
                        window.refresh();
                    });
                });
                return true;
            }
            "pets" => self.pets_anchor.clone(),
            _ => return false,
        };
        window.on_next_frame(move |window, cx| anchor.scroll_to(window, cx));
        true
    }
}

impl AppearancePage {
    /// The UI font size stepper: gpui-kit's `NumberInput` put together
    /// from its parts (its frame, its − and + buttons, the field between
    /// them, its Up and Down keys), because the kit's disables both
    /// buttons or neither, and each must be drawn disabled at its own end
    /// of [`UI_FONT_SIZES`]. A step changes the size as View › Zoom Out
    /// and Zoom In do, and the field shows it.
    fn render_font_size(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let size = AppPreferences::current(cx).ui_font_size;
        let focused = self.font_size.read(cx).focus_handle(cx).is_focused(window);
        let theme = cx.theme();
        let (radius, input, ring) = (theme.radius, theme.input, theme.ring);
        // The kit's step buttons: ghost-like, tinted to the frame on hover.
        let (ink, hover, active) =
            (theme.secondary_foreground, theme.input.opacity(0.4), theme.input.opacity(0.6));
        let ink_disabled = cx.maka().ink_disabled;
        // Inside the 1px frame, a pixel tighter than its corners.
        let inner = (radius - px(1.)).max(px(0.));
        let field = self.font_size.clone();
        let step = |id: &'static str, icon: IconName, label: Text, step: FontSizeStep| {
            let enabled = match step {
                FontSizeStep::Smaller => size > *UI_FONT_SIZES.start(),
                _ => size < *UI_FONT_SIZES.end(),
            };
            let field = field.clone();
            StepButton::new(id)
                .accessibility_label(label.get(cx))
                // Stepping is driven from the field: the buttons never take
                // focus, they give it to the field.
                .focusable(false)
                .disabled(!enabled)
                .flex_none()
                .h_full()
                .min_w_8()
                .text_color(if enabled { ink } else { ink_disabled })
                .when(enabled, |this| {
                    this.hover(|this| this.bg(hover)).active(|this| this.bg(active))
                })
                .map(|this| match step {
                    FontSizeStep::Smaller => this.rounded_tl(inner).rounded_bl(inner),
                    _ => this.rounded_tr(inner).rounded_br(inner),
                })
                .child(Icon::new(icon).with_size(Size::Medium))
                .on_click(move |_, window, cx| {
                    field.update(cx, |field, cx| field.focus(window, cx));
                    step_ui_font_size(step, cx);
                })
        };
        let unit =
            div().text_sm().text_color(cx.maka().ink_muted).child(copy::FONT_SIZE_UNIT.get(cx));
        h_flex()
            .id("settings-ui-font-size-stepper")
            .role(Role::SpinButton)
            .aria_label(copy::UI_FONT_SIZE.get(cx))
            .aria_numeric_value(f64::from(size))
            .aria_min_numeric_value(f64::from(*UI_FONT_SIZES.start()))
            .aria_max_numeric_value(f64::from(*UI_FONT_SIZES.end()))
            // The kit's keys: Up and Down in the field step it.
            .key_context(NUMBER_INPUT_CONTEXT)
            .on_action(|_: &Increment, _, cx| step_ui_font_size(FontSizeStep::Larger, cx))
            .on_action(|_: &Decrement, _, cx| step_ui_font_size(FontSizeStep::Smaller, cx))
            .w(rems(8.25))
            .input_h(Size::Medium)
            .rounded(radius)
            .field_fill(cx)
            .border_1()
            .border_color(if focused { ring } else { input })
            .when(focused, |this| this.focus_ring_style(window, cx))
            .child(step(
                "settings-ui-font-size-smaller",
                IconName::Minus,
                copy::FONT_SIZE_DECREASE,
                FontSizeStep::Smaller,
            ))
            .child(
                div().flex_1().min_w_0().h_full().child(
                    Input::new(&self.font_size)
                        .appearance(false)
                        .h_full()
                        .gap_0()
                        .rounded_none()
                        .text_align(TextAlign::Center)
                        .suffix(unit),
                ),
            )
            .child(step(
                "settings-ui-font-size-larger",
                IconName::Plus,
                copy::FONT_SIZE_INCREASE,
                FontSizeStep::Larger,
            ))
            .into_any_element()
    }
}

impl Render for AppearancePage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let preferences = AppPreferences::current(cx);
        let cards = THEMES
            .map(|appearance| theme_card(appearance, appearance == preferences.appearance, cx));
        let theme = SettingsGroup::new("theme")
            .title(copy::THEME.get(cx))
            .description(copy::THEME_HELP.get(cx))
            .bare()
            .child(
                h_flex()
                    .id("settings-theme")
                    .role(Role::RadioGroup)
                    .w_full()
                    .items_stretch()
                    .gap_2()
                    .children(cards),
            );
        let palettes = PALETTE_GROUPS.map(|(key, label, group)| {
            let cards: Vec<gpui_kit::Div> = group
                .iter()
                .map(|palette| palette_card(*palette, *palette == preferences.palette, cx))
                .collect();
            v_flex()
                .gap_1p5()
                .child(
                    div()
                        .id(domain_element_id("settings-palette-group", key))
                        .aria_label(label.get(cx))
                        .text_xs()
                        .font_medium()
                        .text_color(cx.maka().ink_muted)
                        .child(label.get(cx)),
                )
                .child(
                    div()
                        .id(domain_element_id("settings-palettes", key))
                        .role(Role::RadioGroup)
                        .w_full()
                        .grid()
                        .grid_cols(PALETTE_COLUMNS)
                        .gap_2()
                        .children(cards),
                )
        });
        let palette = SettingsGroup::new("palette")
            .title(copy::PALETTE.get(cx))
            .description(copy::PALETTE_HELP.get(cx))
            .bare()
            .children(palettes);
        let size = self.render_font_size(window, cx);
        let font_size = SettingsGroup::new("font-size")
            .title(copy::FONT_SIZE.get(cx))
            .description(copy::FONT_SIZE_HELP.get(cx))
            .child(
                SettingsRow::new("ui-font-size", copy::UI_FONT_SIZE.get(cx))
                    .detail(copy::UI_FONT_SIZE_HELP.get(cx))
                    .end(div().id("settings-ui-font-size").child(size)),
            );
        let font_size = div()
            .id("settings-appearance-font-size")
            .anchor_scroll(Some(self.font_size_anchor.clone()))
            .child(font_size);
        let sidebar = SettingsGroup::new("sidebar").title(copy::SIDEBAR.get(cx)).child(
            SettingsRow::new("narrow-sidebar", copy::NARROW_SIDEBAR.get(cx))
                .detail(copy::NARROW_SIDEBAR_HELP.get(cx))
                .end(render_narrow_sidebar(preferences.narrow_sidebar, cx)),
        );
        let app_icon = div()
            .id("settings-appearance-app-icon")
            .anchor_scroll(Some(self.app_icon_anchor.clone()))
            .child(self.app_icon.clone());
        let pets = div()
            .id("settings-appearance-pets")
            .anchor_scroll(Some(self.pets_anchor.clone()))
            .child(self.pets.clone());
        v_flex()
            .w_full()
            .gap_8()
            .child(theme)
            .child(palette)
            .child(font_size)
            .child(sidebar)
            .child(app_icon)
            .child(pets)
    }
}

/// Collapse to icons / Hide: the sidebar's segmented control, each segment a
/// Tab stop with Enter or Space. A choice applies at once, in every window.
fn render_narrow_sidebar(
    chosen: NarrowSidebar,
    cx: &mut Context<AppearancePage>,
) -> impl IntoElement + use<> {
    segmented_track(cx)
        .id("settings-narrow-sidebar")
        .test_support()
        .aria_label(copy::NARROW_SIDEBAR.get(cx))
        .flex_shrink_0()
        .children(NarrowSidebar::ALL.map(|narrow| {
            let button = Button::new(domain_element_id("settings-narrow-sidebar", narrow.key()));
            segment(button, narrow.label().get(cx), narrow == chosen, cx)
                .flex_none()
                .px_3()
                .on_click(move |_, _, cx| choose_narrow_sidebar(narrow, cx))
        }))
}

fn theme_card(
    appearance: Appearance,
    selected: bool,
    cx: &mut Context<AppearancePage>,
) -> gpui_kit::Div {
    let maka = cx.maka();
    let label = appearance.label().get(cx);
    let button = Button::new(domain_element_id("settings-theme", appearance.key()))
        .p_2()
        .accessibility_label(label)
        .toggled(selected)
        .on_click(move |_, _, cx| choose_appearance(appearance, cx))
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .items_start()
                .gap_2()
                .whitespace_normal()
                .child(preview(appearance, cx))
                .child(
                    v_flex()
                        .gap_0p5()
                        .child(div().text_sm().font_medium().text_color(maka.ink).child(label))
                        .child(
                            div()
                                .text_xs()
                                .line_height(rems(1.25))
                                .text_color(maka.ink_muted)
                                .child(help(appearance).get(cx)),
                        ),
                ),
        );
    selectable_card(button, selected, cx).flex_1()
}

/// A palette's card, as Desktop's: its swatch, then its name and line. The
/// chosen one carries the accent ring and reads as pressed.
fn palette_card(
    palette: ThemePalette,
    selected: bool,
    cx: &mut Context<AppearancePage>,
) -> gpui_kit::Div {
    let maka = cx.maka();
    let (label, line) = palette_copy(palette);
    let button = Button::new(domain_element_id("settings-palette", palette.id()))
        .p_2()
        .justify_start()
        .accessibility_label(label.get(cx))
        .toggled(selected)
        .on_click(move |_, _, cx| choose_palette(palette, cx))
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .gap_2()
                .whitespace_normal()
                .child(swatch(palette, cx))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .items_start()
                        .gap_0p5()
                        .child(
                            div().text_sm().font_medium().text_color(maka.ink).child(label.get(cx)),
                        )
                        .child(
                            div()
                                .text_xs()
                                .line_height(rems(1.25))
                                .text_color(maka.ink_muted)
                                .child(line.get(cx)),
                        ),
                ),
        );
    selectable_card(button, selected, cx)
}

/// A palette's swatch, Desktop's mark: one 32px disc in the palette's
/// light-mode accent inside a 2px ring of the border, the same whichever
/// palette and appearance the page is in, with Desktop's 2px ring of white
/// at 25% inside the edge, which keeps a dark disc (Minimal gray's) visible
/// on the dark plate.
fn swatch(palette: ThemePalette, cx: &mut Context<AppearancePage>) -> impl IntoElement {
    let accent = MakaPalette::for_palette(palette, ThemeMode::Light).accent;
    let glint = MakaPalette::light().plate.opacity(0.25);
    div()
        .flex_shrink_0()
        .size(rems(SWATCH_REMS))
        .rounded_full()
        .border_2()
        .border_color(cx.maka().border)
        .bg(accent)
        .child(div().size_full().rounded_full().border_2().border_color(glint))
}

/// A small window in `appearance`: the sidebar strip, two lines of reply,
/// and a message bubble, in that mode's palette whatever the app shows now,
/// so the cards can be compared. Follow system shows both halves.
fn preview(appearance: Appearance, cx: &mut Context<AppearancePage>) -> impl IntoElement {
    let panes: Vec<MakaPalette> = match appearance {
        Appearance::Light => vec![MakaPalette::light()],
        Appearance::Dark => vec![MakaPalette::dark()],
        _ => vec![MakaPalette::light(), MakaPalette::dark()],
    };
    let split = panes.len() > 1;
    let last = panes.len() - 1;
    // The panes' own corners, inside the ring: gpui clips children to a
    // rectangle, so a pane fill would square the frame's corners.
    let inner = RADIUS_CONTROL - gpui_kit::px(1.);
    h_flex()
        .w_full()
        .h(rems(PREVIEW_HEIGHT_REMS))
        .rounded(RADIUS_CONTROL)
        .overflow_hidden()
        .border_1()
        .border_color(cx.maka().border)
        .children(panes.into_iter().enumerate().map(move |(ix, palette)| {
            h_flex()
                .flex_1()
                .h_full()
                .bg(palette.plate)
                .when(ix == 0, |this| this.rounded_l(inner))
                .when(ix == last, |this| this.rounded_r(inner))
                .when(split && ix == 0, |this| this.border_r_1().border_color(palette.border))
                .child(
                    div()
                        .w(rems(1.125))
                        .h_full()
                        .bg(palette.canvas)
                        .when(ix == 0, |this| this.rounded_l(inner)),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .h_full()
                        .p_2()
                        .gap_1()
                        .justify_center()
                        .child(
                            div().h_1().w(relative(0.7)).rounded_full().bg(palette.border_strong),
                        )
                        .child(
                            div().h_1().w(relative(0.45)).rounded_full().bg(palette.border_strong),
                        )
                        .child(h_flex().w_full().justify_end().child(
                            div().h_2().w(relative(0.35)).rounded_full().bg(palette.bubble),
                        )),
                )
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_groups_hold_every_palette_once_in_desktops_order() {
        let listed: Vec<ThemePalette> =
            PALETTE_GROUPS.iter().flat_map(|(_, _, palettes)| palettes.iter().copied()).collect();
        assert_eq!(listed, ThemePalette::ALL);
    }
}
