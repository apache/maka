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

//! Maka's palette, from `$MAKA_REPO/DESIGN.md` §2–§8 and the table in
//! `docs/design/polish-2026-09-26.md` §1, and Desktop's other palettes
//! derived from their base colours ([`crate::palette`]).
//!
//! This module and [`crate::palette`] are the only places colour literals
//! live. Views read roles through [`ActiveMakaPalette::maka`]
//! (`cx.maka().plate`), which follows gpui-kit's current [`ThemeMode`] and
//! the palette chosen with [`set_theme_palette`], so switching appearance
//! needs nothing here. [`apply_kit_theme`] maps the same roles onto
//! gpui-kit's own theme colours, so kit components (buttons, inputs, menus,
//! dialogs, lists, scrollbars) paint in them too; the preferences call it
//! after every appearance change.
//!
//! Type: gpui-kit sets the window's rem from the theme's base font, and its
//! scale is built on a 16px rem: `text_sm()` is 14px (body, labels, rows),
//! `text_xs()` 12px (supporting), `h_8()` 32px, `size_7()` 28px, as the
//! spec's pixel values assume. So the base font stays 16px and body text is
//! 14px by being the default text size of the window ([`BODY_TEXT_REMS`], set
//! on the window's `Root`), not by shrinking the rem, which would take every
//! kit control label to 12.25px and every supporting line to 10.5px. The UI
//! font size preference ([`set_ui_font_size`]) scales that rem, and with it
//! every rem-sized text, control, and gap.

use std::sync::{Arc, LazyLock};

use gpui_kit::component::button::{
    Button, ButtonCustomVariant, ButtonVariant, ButtonVariants as _,
};
use gpui_kit::component::kbd::Kbd;
use gpui_kit::component::{
    ActiveTheme, Colorize as _, Icon, IconName, Sizable as _, StyledExt as _, Theme, ThemeColor,
    ThemeMode, ThemeStyled as _, ThemeTokens, h_flex,
};
use gpui_kit::{
    AnyElement, App, BoxShadow, Div, FontFeatures, FontWeight, Global, Hsla, InteractiveElement,
    IntoElement, ParentElement as _, Pixels, Rems, Role, SharedString,
    StatefulInteractiveElement as _, Styled, TestSupportExt as _, div, prelude::FluentBuilder as _,
    px, rems, rgb, rgba,
};

use crate::copy::Locale;
use crate::icons::MakaIcon;
use crate::palette::{self, ThemePalette};

/// Body text (14px at the 16px rem): the window's default text size.
pub const BODY_TEXT_REMS: f32 = 0.875;
/// Body line height (20px on 14px text): the window's default.
pub const BODY_LINE_HEIGHT: f32 = 20. / 14.;

/// Display text (the empty state's line): 22px on 32px lines.
pub const DISPLAY_TEXT_REMS: f32 = 1.375;
pub const DISPLAY_LINE_REMS: f32 = 2.;
/// Headings (dialog titles): 16px semibold on 24px lines.
pub const HEADING_TEXT_REMS: f32 = 1.;
pub const HEADING_LINE_REMS: f32 = 1.5;

/// A group heading's text (the task list's "Today"): 12px supporting text,
/// or 14px in Chinese, as Maka Desktop sets "最近" (its 12px glyphs sit at
/// the legibility floor). Both are rungs of Maka's type scale.
pub fn group_label_size(locale: Locale) -> Rems {
    rems(if locale.is_cjk() { 0.875 } else { 0.75 })
}

/// Figures of equal width, so ages and counts line up in their lanes. Built
/// once: rows ask for it every frame.
pub fn tabular_nums() -> FontFeatures {
    static TABULAR: LazyLock<FontFeatures> =
        LazyLock::new(|| FontFeatures(Arc::new(vec![("tnum".into(), 1)])));
    TABULAR.clone()
}

/// An icon button that sits on a row (the task row's "…"): no fill at
/// rest, the `wash` (ink 6%) under the pointer and the `selected` fill
/// while its menu is open, so it still reads over the row's own hover
/// wash. gpui-kit's ghost variant hovers with the row wash itself.
pub fn row_icon_button(button: Button, cx: &App) -> Button {
    let palette = cx.maka();
    button.custom(
        ButtonCustomVariant::new(cx)
            .color(Hsla::transparent_black())
            .foreground(palette.ink_muted)
            .hover(palette.wash)
            .active(palette.selected)
            .shadow(false),
    )
}

/// A row of a list with one chosen row (the settings nav; the rows of
/// Extensions and Scheduled tasks, which are never drawn chosen since
/// their detail is a modal), as Maka Desktop's `SideNavItem` tells them
/// apart: the chosen row takes the `selected` fill (its label takes weight
/// 500, which the caller sets on the label); any other row takes half that
/// fill under the pointer, visibly lighter, with no change to its text.
/// The main sidebar's task rows keep the plain hover wash (review round 8).
pub fn selectable_row<E: Styled + InteractiveElement>(row: E, selected: bool, cx: &App) -> E {
    let palette = cx.maka();
    if selected {
        row.bg(palette.selected)
    } else {
        let hover = palette.selected.opacity(0.5);
        row.hover(move |this| this.bg(hover))
    }
}

/// A status colour's tinted surface (DESIGN.md §8 `--color-*-muted`): the
/// one 0.24 rung, read with ink on it (the Tinted Surface Rule) and ringed,
/// if at all, in `border`.
pub fn tinted(status: Hsla) -> Hsla {
    status.opacity(0.24)
}

/// Desktop's notice, Astryx `Banner` (status warning), for every notice in
/// the window: on [`notice_surface`], the warning glyph on the title's
/// 20px line, 8 before the text column (the Banner's `columnGap`). The
/// caller adds the column: a [`banner_title`], then any lines under it.
pub fn banner(cx: &App) -> Div {
    let palette = cx.maka();
    notice_surface(cx).flex().flex_row().items_start().gap_2().child(
        div()
            .flex_shrink_0()
            .h_5()
            .flex()
            .items_center()
            .child(Icon::new(IconName::TriangleAlert).size_4().text_color(palette.warning)),
    )
}

/// A [`banner`]'s title: 14/20 semibold ink (the Banner's title), the
/// whole notice when it says one thing.
pub fn banner_title(title: impl Into<SharedString>) -> Div {
    div().flex_1().min_w_0().font_semibold().child(title.into())
}

/// A [`banner`]'s description, under its title with no gap: the Banner's
/// supporting size, 12/20, in ink, as text on a tint is (DESIGN.md's
/// Tinted Surface Rule).
pub fn banner_description(text: impl Into<SharedString>) -> Div {
    div().min_w_0().text_xs().line_height(px(20.)).child(text.into())
}

/// The one attention notice, on [`tinted`] warning: Astryx's Banner
/// header, with no ring, at the container radius (12) and padding 12/16,
/// its text ink at 14/20 (review rounds 11, 12 and 16). [`banner`] lays
/// out what is inside.
pub fn notice_surface(cx: &App) -> Div {
    let palette = cx.maka();
    div()
        .w_full()
        .px_4()
        .py_3()
        .rounded(RADIUS_MODAL)
        .bg(tinted(palette.warning))
        .text_sm()
        .line_height(px(20.))
        .text_color(palette.ink)
}

/// Radius of controls: buttons, inputs, selects, sidebar rows, the
/// segmented control (DESIGN.md §6 "surface").
pub const RADIUS_SURFACE: Pixels = px(10.);
/// Radius of the plate, dialogs and menus (DESIGN.md §6 "modal").
pub const RADIUS_MODAL: Pixels = px(12.);
/// Radius of chips, keycaps and inline code (DESIGN.md §6 "control").
pub const RADIUS_CONTROL: Pixels = px(6.);

/// A square icon plate's radius: Desktop's `--radius-plate`, 27% of its
/// side (a proportional mark, DESIGN.md §6).
pub fn plate_radius(side: Pixels) -> Pixels {
    side * 0.27
}

/// Every colour role the Maka UI uses. Two ink tiers only (`ink`,
/// `ink_muted`); accent is signal, never a flood; brand is the wordmark only.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MakaPalette {
    /// Window floor and sidebar (DESIGN.md `surface-base`).
    pub canvas: Hsla,
    /// The main reading plate and the composer dock (`surface-raised`).
    pub plate: Hsla,
    /// Menus, popovers, dialogs, toasts (`surface-overlay`).
    pub overlay: Hsla,
    /// A side rail inside an overlay (the settings dialog's section list):
    /// one tier below the overlay, so the dialog keeps one silhouette. The
    /// canvas in light, where the overlay is the plate's white; the raised
    /// plate in dark, never the floor (DESIGN.md §2).
    pub rail: Hsla,
    /// Recessed chrome: segmented track, empty send button (`surface-sunken`).
    pub sunken: Hsla,
    /// The user message bubble.
    pub bubble: Hsla,
    /// Blocks of machine text on the plate: code blocks, expanded tool output
    /// and a prompt's command. Below the plate in dark mode, as Maka
    /// Desktop's code blocks (#111111) are; inline code takes `wash`.
    pub code: Hsla,
    /// Primary text and icons.
    pub ink: Hsla,
    /// Secondary text and icons: the only other text tier.
    pub ink_muted: Hsla,
    /// A disabled control's glyph or label: Maka's `--color-text-disabled`,
    /// the one sub-AA value DESIGN.md allows, so the state reads as a state.
    pub ink_disabled: Hsla,
    /// Structural boundaries (ink at 10%).
    pub border: Hsla,
    /// Dividers inside a group (ink at 6%).
    pub border_soft: Hsla,
    /// Emphasis chrome and the scrollbar thumb (ink at 16%, DESIGN.md §4).
    pub border_strong: Hsla,
    /// Row and control hover wash.
    pub hover: Hsla,
    /// Selected row fill.
    pub selected: Hsla,
    /// The keyboard-active or hovered row in a menu or the command palette:
    /// ink 8% in light (a 4% wash is invisible on the white overlay).
    pub active_row: Hsla,
    /// Ink at 6%: inline code (Maka Desktop's `--muted` is ink at 5%, so it
    /// reads on the plate in both modes), the empty send button, a row icon
    /// button's hover.
    pub wash: Hsla,
    /// Opaque quiet fill: the connection monograms and project discs.
    pub chip: Hsla,
    /// Ink at 8% (9% dark): the badge fill, translucent so a badge layers
    /// over the canvas, the plate and a hovered or selected row alike.
    pub badge: Hsla,
    /// The one solid call to action (send) and links.
    pub primary: Hsla,
    /// Text and icons on `primary`.
    pub on_primary: Hsla,
    /// Focus ring, selection, live state.
    pub accent: Hsla,
    /// The Maka wordmark colour; never a call to action.
    pub brand: Hsla,
    /// Status ink and dots.
    pub success: Hsla,
    pub warning: Hsla,
    pub destructive: Hsla,
    /// The warning badge's solid fill and the ink on it (Desktop's
    /// `--astryx-theme-neutral-color-status-fill-warning` and
    /// `--color-on-warning`), the same in both modes.
    pub warning_fill: Hsla,
    pub on_warning: Hsla,
    /// The backdrop behind a modal dialog.
    pub scrim: Hsla,
}

impl MakaPalette {
    /// The roles of Desktop's `palette` in `mode`. The default palette is
    /// [`light`](Self::light) and [`dark`](Self::dark); the others derive
    /// from their base colours by Desktop's rules, once, on first use.
    pub fn for_palette(palette: ThemePalette, mode: ThemeMode) -> Self {
        static RESOLVED: LazyLock<[[MakaPalette; 2]; ThemePalette::ALL.len()]> =
            LazyLock::new(|| {
                ThemePalette::ALL
                    .map(|each| [palette::resolve(each, false), palette::resolve(each, true)])
            });
        RESOLVED[palette as usize][usize::from(mode.is_dark())]
    }

    /// The default palette in light mode: Desktop's default, with the
    /// values the UI was reviewed with where they depart from it.
    pub fn light() -> Self {
        Self {
            canvas: rgb(0xF7F7F7).into(),
            plate: rgb(0xFFFFFF).into(),
            overlay: rgb(0xFFFFFF).into(),
            rail: rgb(0xF7F7F7).into(),
            sunken: rgb(0xEDEDED).into(),
            bubble: rgb(0xF2F2F3).into(),
            code: rgb(0xF1F1F1).into(),
            ink: rgb(0x0F0F12).into(),
            ink_muted: rgb(0x525252).into(),
            ink_disabled: rgb(0xA3A3A3).into(),
            border: rgba(0x0F0F121A).into(),
            border_soft: rgba(0x0F0F120F).into(),
            border_strong: rgba(0x0F0F1229).into(),
            hover: rgba(0x0F0F120A).into(),
            selected: rgba(0x0F0F120F).into(),
            active_row: rgba(0x0F0F1214).into(),
            wash: rgba(0x0F0F120F).into(),
            chip: rgb(0xEDEDED).into(),
            badge: rgba(0x0F0F1214).into(),
            primary: rgb(0x0260A6).into(),
            on_primary: rgb(0xFFFFFF).into(),
            accent: rgb(0x57A3EF).into(),
            brand: rgb(0x71A8FD).into(),
            success: rgb(0x007A11).into(),
            warning: rgb(0xAB3900).into(),
            destructive: rgb(0xC90000).into(),
            warning_fill: rgb(0xFFCE2F).into(),
            on_warning: rgb(0x111111).into(),
            scrim: rgba(0x00000033).into(),
        }
    }

    /// The default palette in dark mode.
    pub fn dark() -> Self {
        Self {
            canvas: rgb(0x111113).into(),
            plate: rgb(0x171719).into(),
            overlay: rgb(0x1B1B1E).into(),
            rail: rgb(0x171719).into(),
            sunken: rgb(0x09090B).into(),
            bubble: rgb(0x242427).into(),
            code: rgb(0x111113).into(),
            ink: rgb(0xEEEEF1).into(),
            ink_muted: rgb(0xA3A3A3).into(),
            ink_disabled: rgb(0x525252).into(),
            border: rgba(0xEEEEF11A).into(),
            border_soft: rgba(0xEEEEF10F).into(),
            border_strong: rgba(0xEEEEF129).into(),
            hover: rgba(0xEEEEF10F).into(),
            selected: rgba(0xEEEEF117).into(),
            active_row: rgba(0xEEEEF117).into(),
            wash: rgba(0xEEEEF10F).into(),
            chip: rgb(0x242427).into(),
            badge: rgba(0xEEEEF117).into(),
            primary: rgb(0x5FB6FF).into(),
            on_primary: rgb(0x171717).into(),
            accent: rgb(0x58B0FF).into(),
            brand: rgb(0x71A8FD).into(),
            success: rgb(0x279936).into(),
            warning: rgb(0xE26C00).into(),
            destructive: rgb(0xFF6367).into(),
            warning_fill: rgb(0xFFCE2F).into(),
            on_warning: rgb(0x111111).into(),
            scrim: rgba(0x00000080).into(),
        }
    }
}

/// `cx.maka()`: the chosen palette's roles for the current appearance.
pub trait ActiveMakaPalette {
    fn maka(&self) -> MakaPalette;
}

impl ActiveMakaPalette for App {
    fn maka(&self) -> MakaPalette {
        MakaPalette::for_palette(theme_palette(self), self.theme().mode)
    }
}

/// The palette every window paints in; the default until one is chosen.
struct ChosenPalette(ThemePalette);

impl Global for ChosenPalette {}

/// Paints every window in `palette` from now on, in whichever appearance is
/// in effect: `cx.maka()` and gpui-kit's theme colours take its roles at
/// once, and every window redraws.
pub fn set_theme_palette(palette: ThemePalette, cx: &mut App) {
    cx.set_global(ChosenPalette(palette));
    apply_kit_theme(cx);
    cx.refresh_windows();
}

/// The palette chosen with [`set_theme_palette`].
pub fn theme_palette(cx: &App) -> ThemePalette {
    cx.try_global::<ChosenPalette>().map(|chosen| chosen.0).unwrap_or_default()
}

/// The UI font size the type scale is drawn at (Maka Desktop's
/// `DEFAULT_UI_FONT_SIZE`): body text is this many pixels.
pub const DEFAULT_UI_FONT_SIZE: u8 = 14;

/// The UI font size every window draws at; the default until one is set.
struct ChosenUiFontSize(u8);

impl Global for ChosenUiFontSize {}

/// Draws every window at the UI font size `size` from now on: body text is
/// `size` pixels and everything sized in rems (text, controls, gaps) scales
/// with it, as Maka Desktop scales its document root to `16 × size / 14`.
/// Radii and hairlines, sized in pixels, stay. Every window redraws.
pub fn set_ui_font_size(size: u8, cx: &mut App) {
    cx.set_global(ChosenUiFontSize(size));
    apply_kit_theme(cx);
    cx.refresh_windows();
}

/// The UI font size set with [`set_ui_font_size`].
pub fn ui_font_size(cx: &App) -> u8 {
    cx.try_global::<ChosenUiFontSize>().map_or(DEFAULT_UI_FONT_SIZE, |chosen| chosen.0)
}

/// The window's rem at the UI font size `size`: gpui-kit's 16px at the
/// default, which the type scale's rem values assume.
fn rem_for(size: u8) -> Pixels {
    px(16. * f32::from(size) / f32::from(DEFAULT_UI_FONT_SIZE))
}

/// The chosen segment of a segmented control, raised off its sunken track:
/// a `border_soft` ring and a 1px shadow at 6% ink (spec §5).
pub fn segment_shadow(palette: &MakaPalette) -> Vec<BoxShadow> {
    vec![
        BoxShadow::new(px(0.), px(0.), palette.border_soft).spread_radius(px(1.)),
        BoxShadow::new(px(0.), px(1.), palette.ink.opacity(0.06)).blur_radius(px(1.)),
    ]
}

/// The shadow of DESIGN.md's floating recipe for portal surfaces (menus,
/// popovers, the jump pill); the surface draws its `border_soft` hairline
/// itself, inside its edge like gpui-kit's dialogs, so the ring reads the
/// same on every portal and no shadow darkens it (review round 5). The
/// shadow is always a dark colour: ink in dark mode is light, and a light
/// shadow reads as a glow (DESIGN.md §5 and §11 forbid glowing edges).
pub fn floating_shadow(palette: &MakaPalette, dark: bool) -> Vec<BoxShadow> {
    let shadow = if dark {
        BoxShadow::new(px(0.), px(8.), gpui_kit::black().opacity(0.5))
            .blur_radius(px(24.))
            .spread_radius(px(-6.))
    } else {
        BoxShadow::new(px(0.), px(8.), palette.ink.opacity(0.08))
            .blur_radius(px(12.))
            .spread_radius(px(-4.))
    };
    vec![shadow]
}

/// DESIGN.md's floating recipe on a portal surface gpui-kit draws (a
/// dialog, an alert): the overlay fill, a `border_soft` hairline and the
/// modal radius. gpui-kit keeps its own animated shadow.
pub fn floating_surface<S: Styled>(surface: S, cx: &App) -> S {
    let palette = cx.maka();
    surface.bg(palette.overlay).border_color(palette.border_soft).rounded(RADIUS_MODAL)
}

/// A text field's fill: the plate, under the field's `border` ring, in
/// both modes. gpui-kit fills a field with the plate in light but, in
/// dark, with a lighter wash of its ring colour, so a dark field drew a
/// fill and a ring (review round 10). Call it on the field (`Input`,
/// `Textarea`, `NumberInput`); a later `bg` still wins.
pub trait FieldFill: Styled + Sized {
    fn field_fill(self, cx: &App) -> Self {
        self.bg(cx.maka().plate)
    }
}

impl<T: Styled> FieldFill for T {}

/// A labeled button at Maka's control size: 32px tall with a 14/500 label
/// (gpui-kit's medium button is 32px with a 16px label, its small one
/// 24px), on the surface radius from the theme. Set the variant on
/// `button` first.
pub fn control_button(button: Button) -> Button {
    button.small().h_8().px_3().font_medium()
}

/// Maka Desktop's row action ("打开工作区文件夹", "复制路径", "编辑"): a
/// [`control_button`] with an ink label on the ink 6% `wash`, a deeper wash
/// under the pointer and while pressed, no ring. The one quiet labeled
/// button of settings rows, page actions and forms; the destructive one
/// is [`destructive_button`].
pub fn quiet_button(button: Button, cx: &App) -> Button {
    let palette = cx.maka();
    tinted_button(button, palette.ink, palette.wash, cx)
}

/// [`quiet_button`]'s look as a gpui-kit variant, for the buttons gpui-kit
/// builds itself (a confirmation's Cancel), where the fill cannot be set on
/// the button: the kit paints a custom variant's resting fill at a fifth
/// of its colour, alpha premultiplied, so the colour carries five times
/// the `wash` and rests at the wash.
pub fn quiet_variant(cx: &App) -> ButtonVariant {
    let palette = cx.maka();
    let fill = palette.wash.a;
    ButtonVariant::Custom(
        ButtonCustomVariant::new(cx)
            .color(palette.ink.opacity((fill * 5.).min(1.)))
            .foreground(palette.ink)
            .hover(palette.ink.opacity(fill + 0.05))
            .active(palette.ink.opacity(fill + 0.1))
            .shadow(false),
    )
}

/// The destructive row action (Desktop's "清空输入历史"): the destructive
/// ink on a 10% wash of it.
pub fn destructive_button(button: Button, cx: &App) -> Button {
    let destructive = cx.maka().destructive;
    tinted_button(button, destructive, destructive.opacity(0.1), cx)
}

/// A [`control_button`] in `ink` on `fill` (`ink` at some opacity) at
/// rest, 5 and 10 points deeper under the pointer and while pressed.
/// gpui-kit paints a custom
/// variant's resting fill at a fifth of its colour, so the fill is set on
/// the button itself; hover and press still come from the variant, and a
/// disabled button keeps the fill with the kit's disabled label.
pub fn tinted_button(button: Button, ink: Hsla, fill: Hsla, cx: &App) -> Button {
    control_button(button)
        .custom(
            ButtonCustomVariant::new(cx)
                .color(fill)
                .foreground(ink)
                .hover(ink.opacity(fill.a + 0.05))
                .active(ink.opacity(fill.a + 0.1))
                .shadow(false),
        )
        .bg(fill)
}

/// An inline text link (Desktop's `Link`): `label` in `ink` at `size` and
/// `weight` with no fill, underlined only under the pointer (Desktop also
/// underlines it on keyboard focus, where this one draws the kit's focus
/// ring): a doc link takes the link colour at 14/500, a link inside a line
/// (Desktop's `type="inherit"`) the line's size, still in the link colour.
/// Both rungs a link sits on, body 14/20 and supporting 12/20, are 20 tall.
/// Set the id and `on_click` on `button`.
pub fn text_link(
    button: Button,
    label: impl Into<SharedString>,
    ink: Hsla,
    size: Rems,
    weight: FontWeight,
    cx: &App,
) -> Button {
    const GROUP: &str = "text-link";
    let label = label.into();
    button
        .custom(
            ButtonCustomVariant::new(cx)
                .color(Hsla::transparent_black())
                .foreground(ink)
                .hover(Hsla::transparent_black())
                .active(Hsla::transparent_black())
                .shadow(false),
        )
        .group(GROUP)
        .h_auto()
        .p_0()
        .rounded(RADIUS_CONTROL)
        .accessibility_label(label.clone())
        .child(
            div()
                .text_size(size)
                .line_height(rems(1.25))
                .font_weight(weight)
                .text_color(ink)
                .group_hover(GROUP, |style| style.text_decoration_1())
                .child(label),
        )
}

/// The back link (Desktop's labelled back button, as Remote access' bot
/// detail and "返回应用" draw it): one recipe for all. A 32px ghost button
/// with `ArrowLeft` 16 muted and its label at 14/500, its arrow on the
/// content column's edge (the hover wash reaches 8px past it). Set the id,
/// `disabled` and `on_click` on `button`; the page puts the returned row
/// 24px above what it leads back from. A sub-page with a title of its own
/// takes [`route_header`] instead.
pub fn back_link(button: Button, label: impl Into<SharedString>, cx: &App) -> Div {
    let palette = cx.maka();
    let label = label.into();
    h_flex().flex_shrink_0().child(
        control_button(button.ghost())
            .px_2()
            .ml(px(-8.))
            .accessibility_label(label.clone())
            .child(h_flex().gap_2().child(back_arrow(palette)).child(label)),
    )
}

/// A sub-page's header, as Maka Desktop's `SettingsRouteHeader` draws it
/// under the page's own title: the way back as a 32px ghost icon button
/// (`ArrowLeft` 16 muted, its label as tooltip and accessible name, the
/// arrow on the column's edge), then `heading`, the sub-page's mark, title
/// and subtitle, on the same row. Set the id, `disabled` and `on_click` on
/// `button`.
pub fn route_header(
    button: Button,
    label: impl Into<SharedString>,
    heading: impl IntoElement,
    cx: &App,
) -> Div {
    let palette = cx.maka();
    let label = label.into();
    let back = button
        .ghost()
        .small()
        .size_8()
        .ml(px(-8.))
        .accessibility_label(label.clone())
        .tooltip(label)
        .child(back_arrow(palette));
    h_flex()
        .w_full()
        .min_w_0()
        .items_center()
        .gap_2()
        .child(back)
        .child(div().flex_1().min_w_0().child(heading))
}

fn back_arrow(palette: MakaPalette) -> Icon {
    Icon::new(gpui_kit::assets::IconName::ArrowLeft).size_4().text_color(palette.ink_muted)
}

/// A disclosure ("展开高级请求设置"): a 32px ghost button with the
/// chevron (right when closed, down when open) 14 muted and the label at
/// 14/500, its chevron on the column's edge like [`back_link`]'s arrow.
pub fn disclosure(button: Button, open: bool, label: impl Into<SharedString>, cx: &App) -> Div {
    let palette = cx.maka();
    let label = label.into();
    let chevron = if open { MakaIcon::ChevronDown } else { MakaIcon::ChevronRight };
    h_flex().flex_shrink_0().child(
        control_button(button.ghost()).px_2().ml(px(-8.)).accessibility_label(label.clone()).child(
            h_flex()
                .gap_2()
                .child(Icon::new(chevron).size_3p5().text_color(palette.ink_muted))
                .child(label),
        ),
    )
}

/// The one badge recipe: a 20px pill for a quiet fact beside a name (the
/// State Root in the sidebar footer, "Default", "Disabled"), 12/500 muted
/// ink on the translucent `badge` fill (DESIGN.md §9 Badge).
pub fn badge(label: impl IntoElement, cx: &App) -> Div {
    let palette = cx.maka();
    h_flex()
        .flex_shrink_0()
        .h_5()
        .px_2()
        .rounded_full_style(cx)
        .bg(palette.badge)
        .text_xs()
        .font_medium()
        .text_color(palette.ink_muted)
        .child(div().truncate().child(label))
}

/// Desktop's `<Badge variant="warning">`: the [`badge`] pill on the solid
/// warning fill with its dark ink, in both modes.
pub fn warning_badge(label: impl IntoElement, cx: &App) -> Div {
    let palette = cx.maka();
    badge(label, cx).bg(palette.warning_fill).text_color(palette.on_warning)
}

/// A main-area page's header, as Maka Desktop's `ModulePage` draws it and
/// the settings pages title theirs: the title at the settings page-title
/// rung (display, 22/32), the page's count beside it (12/400 muted) on the
/// title's centre line (Desktop's `HStack vAlign="center"`), and the page's
/// `actions` at the column's end, on one row. The page puts it at the top
/// of its content column, over its [`page_bar`]. The title is `page-title`
/// (a heading), the count `page-meta`.
pub fn page_header(
    title: impl Into<SharedString>,
    meta: Option<SharedString>,
    actions: AnyElement,
    cx: &App,
) -> AnyElement {
    let palette = cx.maka();
    let title = title.into();
    h_flex()
        .id("page-header")
        .test_support()
        .w_full()
        .items_center()
        .justify_between()
        .gap_4()
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .id("page-title")
                        .test_support()
                        .role(Role::Heading)
                        .aria_label(title.clone())
                        .flex_shrink_0()
                        .text_size(rems(DISPLAY_TEXT_REMS))
                        .line_height(rems(DISPLAY_LINE_REMS))
                        .text_color(palette.ink)
                        .child(title),
                )
                .children(meta.map(|meta| {
                    div()
                        .id("page-meta")
                        .test_support()
                        .aria_label(meta.clone())
                        .min_w_0()
                        .truncate()
                        .text_xs()
                        .text_color(palette.ink_muted)
                        .child(meta)
                })),
        )
        .child(div().flex_shrink_0().child(actions))
        .into_any_element()
}

/// A key binding as a hint beside a command: plain 12px muted text ("⌘N"),
/// never a keycap, in the sidebar, the command palette and menus alike.
pub fn shortcut_hint(kbd: Kbd, cx: &App) -> Div {
    div().flex_shrink_0().text_xs().text_color(cx.maka().ink_muted).child(kbd.appearance(false))
}

/// A segmented control's track: 28px, sunken, surface radius (spec §5).
pub fn segmented_track(cx: &App) -> Div {
    // Dark: the ink wash, not the sunken tier, which would be the darkest
    // surface on screen, a hole in the canvas (review round 7).
    let fill = if cx.theme().is_dark() { cx.maka().wash } else { cx.maka().sunken };
    h_flex().h_7().p_0p5().gap_0p5().rounded(RADIUS_SURFACE).bg(fill)
}

/// A main-area page's one control bar, Desktop's `.maka-module-page-bar`:
/// the module tabs at the start and this view's controls at the end, on one
/// row (gap 12; wrapping, 8 between rows), 12 under the header's 16 and with
/// no rule under it. `controls` is `None` where the view has none.
pub fn page_bar(tabs: AnyElement, controls: Option<AnyElement>) -> Div {
    h_flex()
        .w_full()
        // A control's height, so the rows do not move when the view's
        // controls come and go.
        .min_h_8()
        .pt_3()
        .flex_wrap()
        .justify_between()
        .gap_x_3()
        .gap_y_2()
        .child(tabs)
        .children(controls)
}

/// One of a page's module tabs: its element id, its label, and its
/// accessible name.
pub type PageTab = (gpui_kit::ElementId, SharedString, SharedString);

/// A page's module tabs as Desktop's `TabList` draws them: label only,
/// 14/20, muted and regular, ink under the pointer; the selected one ink at
/// 600 with a 2px `accent` indicator under its label; no rule under the
/// strip (`hasDivider` false). The first label starts on the column's edge.
/// A click calls `on_select` with the tab's index.
pub fn page_tabs(
    id: impl Into<gpui_kit::ElementId>,
    label: impl Into<SharedString>,
    tabs: Vec<PageTab>,
    selected: usize,
    on_select: impl Fn(usize, &mut gpui_kit::Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let palette = cx.maka();
    let on_select = std::rc::Rc::new(on_select);
    h_flex()
        .id(id)
        .test_support()
        .role(Role::TabList)
        .aria_label(label.into())
        .flex_shrink_0()
        .gap_4()
        .children(tabs.into_iter().enumerate().map(|(ix, (id, label, spoken))| {
            let chosen = ix == selected;
            let on_select = on_select.clone();
            div()
                .id(id)
                .test_support()
                .role(Role::Tab)
                .aria_label(spoken)
                .aria_selected(chosen)
                .relative()
                .h_8()
                .flex()
                .items_center()
                .cursor_pointer()
                .text_sm()
                .line_height(rems(1.25))
                .map(|this| {
                    if chosen {
                        this.font_semibold().text_color(palette.ink)
                    } else {
                        let ink = palette.ink;
                        this.text_color(palette.ink_muted).hover(move |this| this.text_color(ink))
                    }
                })
                .child(label)
                .when(chosen, |this| {
                    this.child(
                        div().absolute().left_0().right_0().bottom_0().h(px(2.)).bg(palette.accent),
                    )
                })
                .on_click(move |_, window, cx| on_select(ix, window, cx))
        }))
        .into_any_element()
}

/// The medium segmented control's track (Astryx `SegmentedControl` at its
/// default size, as Usage's period): 32px, otherwise [`segmented_track`].
pub fn segmented_track_md(cx: &App) -> Div {
    segmented_track(cx).h_8()
}

/// One segment of a [`segmented_track_md`]: [`segment`]'s recipe at the
/// medium size, 28px with its label 14/500, the chosen one's 14/600.
pub fn segment_md(button: Button, label: &str, selected: bool, cx: &App) -> Button {
    let weight = if selected { FontWeight::SEMIBOLD } else { FontWeight::MEDIUM };
    segment_in(
        button,
        div().text_sm().font_weight(weight).child(label.to_owned()),
        label,
        selected,
        cx,
    )
    .h_7()
}

/// One segment of a [`segmented_track`]: `button` with a 12/500 `label`,
/// when `selected` sitting on the plate with a soft ring and a 1px shadow
/// in light, and in dark a step above the overlay in a `border` ring;
/// in muted ink otherwise. The button keeps its focus, keyboard and
/// toggled state.
pub fn segment(button: Button, label: &str, selected: bool, cx: &App) -> Button {
    // 12/500, as Maka Desktop's small segmented labels.
    segment_in(button, div().text_xs().font_medium().child(label.to_owned()), label, selected, cx)
}

/// A segment holding `content`, named `label`.
fn segment_in(button: Button, content: Div, label: &str, selected: bool, cx: &App) -> Button {
    let palette = cx.maka();
    button
        .ghost()
        .small()
        .flex_1()
        .rounded(RADIUS_CONTROL)
        .accessibility_label(label.to_owned())
        .child(content)
        .toggled(selected)
        .map(|this| {
            if selected && cx.theme().is_dark() {
                // Above the overlay tier, so it never sits lower than its
                // surface (DESIGN.md §2 Height Rule), ringed as Desktop's
                // dark `--shadow-low` rings it (an inset 1px of white): the
                // fill step alone is 1.14:1 on the track (review round 12).
                this.bg(over(palette.overlay, palette.active_row))
                    .border_1()
                    .border_color(palette.border)
                    .text_color(palette.ink)
            } else if selected {
                this.bg(palette.plate).shadow(segment_shadow(&palette)).text_color(palette.ink)
            } else {
                this.text_color(palette.ink_muted)
            }
        })
}

/// Maps the chosen palette's roles for the theme's current mode onto every
/// gpui-kit theme colour that reaches the screen, sets the radii and the
/// base font size (the rem, from [`set_ui_font_size`]), and brings
/// the theme's tokens and the Base layer (scrollbars, resize handles) back
/// in step.
///
/// Call it after every `Theme::change` (which reloads gpui-kit's default
/// colours for the mode), then refresh the windows. Kit roles that have no
/// Maka meaning (charts, the magenta and cyan bases) keep gpui-kit's values.
pub fn apply_kit_theme(cx: &mut App) {
    let command_open = cx.try_global::<OpenCommandLists>().is_some_and(|open| open.0 > 0);
    let chosen = theme_palette(cx);
    let rem = rem_for(ui_font_size(cx));
    let theme = Theme::global_mut(cx);
    let dark = theme.mode.is_dark();
    let palette = MakaPalette::for_palette(chosen, theme.mode);
    map_colors(&mut theme.colors, &palette, dark);
    if command_open {
        theme.colors.accent = palette.active_row;
    }
    theme.tokens = ThemeTokens::from(&theme.colors);
    theme.radius = RADIUS_SURFACE;
    theme.radius_lg = RADIUS_MODAL;
    // gpui-kit's `Root` sets the window's rem from it on every frame.
    theme.font_size = rem;
    Theme::sync_base(cx);
}

/// How many gpui-kit Command lists are open.
///
/// gpui-kit paints a Command list's highlighted row with the theme's
/// `accent`, which Maka keeps at the hover wash because ghost buttons hover
/// with it. While a Command list is open (it sits in a modal dialog, so no
/// ghost button behind it can be hovered) its highlight takes the
/// active-row fill of the menus instead.
#[derive(Default)]
struct OpenCommandLists(usize);

impl Global for OpenCommandLists {}

/// A Command list opened: its highlighted row takes the active-row fill.
/// Pair every call with [`command_list_closed`].
pub fn command_list_opened(cx: &mut App) {
    cx.default_global::<OpenCommandLists>().0 += 1;
    apply_kit_theme(cx);
}

/// A Command list closed: once none is open, `accent` is the hover wash
/// again.
pub fn command_list_closed(cx: &mut App) {
    let open = cx.default_global::<OpenCommandLists>();
    open.0 = open.0.saturating_sub(1);
    apply_kit_theme(cx);
    cx.refresh_windows();
}

/// A wash (`hover`, `selected`) laid over an opaque surface, for kit roles
/// that must be opaque.
fn over(surface: Hsla, wash: Hsla) -> Hsla {
    surface.blend(wash)
}

fn map_colors(colors: &mut ThemeColor, p: &MakaPalette, dark: bool) {
    let transparent = Hsla::transparent_black();
    // Pressing a solid fill darkens it in light mode and lightens it in dark,
    // one step either way; hovering one lays the hover wash over it.
    let pressed = |fill: Hsla| if dark { fill.lighten(0.08) } else { fill.darken(0.08) };
    let hovered = |fill: Hsla| fill.blend(p.ink.opacity(if dark { 0.08 } else { 0.06 }));

    // Surfaces and ink.
    colors.background = p.plate;
    colors.foreground = p.ink;
    colors.muted = p.sunken;
    colors.muted_foreground = p.ink_muted;
    colors.border = p.border;
    // The ring of fields, selects and an unchecked checkbox: Desktop's
    // --color-border-emphasized, which Maka maps to --border-strong (ink
    // 16%), the off switch's track too. It stays under 3:1 on white, as
    // Desktop's does (review round 11).
    colors.input = p.border_strong;
    colors.ring = p.accent;
    colors.selection = p.accent.opacity(0.3);
    colors.caret = p.ink;
    colors.popover = p.overlay;
    colors.popover_foreground = p.ink;
    colors.overlay = p.scrim;
    colors.window_border = p.border;
    colors.drag_border = p.accent;
    colors.drop_target = p.accent.opacity(0.24);
    colors.link = p.primary;
    colors.link_hover = p.primary;
    colors.link_active = p.primary;

    // gpui-kit's `accent` is the hover wash of menu items, list items and
    // ghost buttons, not Maka's accent (which is the focus ring above).
    colors.accent = p.hover;
    colors.accent_foreground = p.ink;

    // Buttons. Default and secondary are the plate with the `border` ring;
    // ghost hovers with the wash and presses with the selected fill.
    colors.button = p.plate;
    colors.button_foreground = p.ink;
    colors.button_hover = over(p.plate, p.hover);
    colors.button_active = over(p.plate, p.selected);
    colors.secondary = p.plate;
    colors.secondary_foreground = p.ink;
    colors.secondary_hover = over(p.plate, p.hover);
    // Translucent, so a ghost button held selected (the footer row while its
    // menu is open) is one `selected` step above whatever it sits on: on the
    // canvas an opaque plate-based fill was lighter than the canvas' own
    // step in light and heavier in dark (review round 7).
    colors.secondary_active = p.selected;
    colors.button_secondary = colors.secondary;
    colors.button_secondary_foreground = colors.secondary_foreground;
    colors.button_secondary_hover = colors.secondary_hover;
    colors.button_secondary_active = colors.secondary_active;
    colors.primary = p.primary;
    colors.primary_foreground = p.on_primary;
    colors.primary_hover = hovered(p.primary);
    colors.primary_active = pressed(p.primary);
    colors.button_primary = colors.primary;
    colors.button_primary_foreground = colors.primary_foreground;
    colors.button_primary_hover = colors.primary_hover;
    colors.button_primary_active = colors.primary_active;

    // Status. There is no info hue: info paints with the accent (DESIGN.md §8).
    for (fill, foreground, hover, active, base, base_light, status) in [
        (
            &mut colors.danger,
            &mut colors.danger_foreground,
            &mut colors.danger_hover,
            &mut colors.danger_active,
            &mut colors.red,
            &mut colors.red_light,
            p.destructive,
        ),
        (
            &mut colors.success,
            &mut colors.success_foreground,
            &mut colors.success_hover,
            &mut colors.success_active,
            &mut colors.green,
            &mut colors.green_light,
            p.success,
        ),
        (
            &mut colors.warning,
            &mut colors.warning_foreground,
            &mut colors.warning_hover,
            &mut colors.warning_active,
            &mut colors.yellow,
            &mut colors.yellow_light,
            p.warning,
        ),
        (
            &mut colors.info,
            &mut colors.info_foreground,
            &mut colors.info_hover,
            &mut colors.info_active,
            &mut colors.blue,
            &mut colors.blue_light,
            p.accent,
        ),
    ] {
        *fill = status;
        *foreground = p.on_primary;
        *hover = hovered(status);
        *active = pressed(status);
        *base = status;
        *base_light = over(p.plate, status.opacity(0.24));
    }
    colors.button_danger = colors.danger;
    colors.button_danger_foreground = colors.danger_foreground;
    colors.button_danger_hover = colors.danger_hover;
    colors.button_danger_active = colors.danger_active;
    // Tinted status buttons (gpui-kit draws these as soft fills with status
    // ink): the 0.24 tint DESIGN.md §8 gives every tinted surface.
    for (fill, foreground, hover, active, status) in [
        (
            &mut colors.button_success,
            &mut colors.button_success_foreground,
            &mut colors.button_success_hover,
            &mut colors.button_success_active,
            p.success,
        ),
        (
            &mut colors.button_warning,
            &mut colors.button_warning_foreground,
            &mut colors.button_warning_hover,
            &mut colors.button_warning_active,
            p.warning,
        ),
        (
            &mut colors.button_info,
            &mut colors.button_info_foreground,
            &mut colors.button_info_hover,
            &mut colors.button_info_active,
            p.accent,
        ),
    ] {
        *fill = status.opacity(0.24);
        *foreground = p.ink;
        *hover = status.opacity(0.32);
        *active = status.opacity(0.4);
    }

    // Lists and tables: transparent rows on whatever surface holds them,
    // hover wash, selected fill, no active outline.
    colors.list = transparent;
    colors.list_even = transparent;
    colors.list_head = transparent;
    colors.list_hover = p.active_row;
    colors.list_active = p.active_row;
    colors.list_active_border = transparent;
    colors.table = transparent;
    colors.table_even = transparent;
    colors.table_head = transparent;
    colors.table_head_foreground = p.ink_muted;
    colors.table_foot = transparent;
    colors.table_foot_foreground = p.ink_muted;
    colors.table_hover = p.hover;
    colors.table_active = p.selected;
    colors.table_active_border = transparent;
    colors.table_row_border = p.border_soft;
    colors.description_list_label = p.canvas;
    colors.description_list_label_foreground = p.ink_muted;
    colors.accordion = p.plate;
    colors.group_box = p.canvas;
    colors.group_box_foreground = p.ink;

    // The sidebar sits on the canvas; its rows hover and select with washes.
    colors.sidebar = p.canvas;
    colors.sidebar_foreground = p.ink;
    colors.sidebar_border = p.border_soft;
    colors.sidebar_accent = p.hover;
    colors.sidebar_accent_foreground = p.ink;
    colors.sidebar_primary = p.primary;
    colors.sidebar_primary_foreground = p.on_primary;
    colors.title_bar = p.canvas;
    colors.title_bar_border = transparent;
    colors.status_bar = p.canvas;
    colors.status_bar_border = p.border_soft;

    // Segmented control and tabs: the track is sunken, the chosen segment
    // sits on the plate.
    colors.tab_bar = p.sunken;
    colors.tab_bar_segmented = p.sunken;
    colors.tab = transparent;
    colors.tab_active = p.plate;
    colors.tab_foreground = p.ink_muted;
    colors.tab_active_foreground = p.ink;

    // Small controls.
    colors.switch = p.border_strong;
    colors.switch_thumb = if dark { p.ink } else { p.plate };
    colors.slider_bar = p.primary;
    colors.slider_thumb = p.plate;
    colors.progress_bar = p.primary;
    colors.skeleton = p.sunken;

    // One scrollbar recipe: no painted track, thumb at `border_strong`, one
    // step darker on hover (DESIGN.md §9).
    colors.scrollbar = transparent;
    colors.scrollbar_thumb = p.border_strong;
    colors.scrollbar_thumb_hover = p.ink.opacity(0.26);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn light_and_dark_keep_two_ink_tiers_apart_from_their_plate() {
        for palette in [MakaPalette::light(), MakaPalette::dark()] {
            assert_ne!(palette.ink, palette.plate);
            assert_ne!(palette.ink_muted, palette.ink);
            assert!(palette.border.a < palette.ink.a, "borders are translucent ink");
            assert_eq!(palette.brand, MakaPalette::light().brand, "brand is fixed across modes");
        }
    }

    #[test]
    fn kit_colours_take_maka_roles_in_both_modes() {
        for (palette, dark) in [(MakaPalette::light(), false), (MakaPalette::dark(), true)] {
            let mut colors = ThemeColor::default();
            map_colors(&mut colors, &palette, dark);
            assert_eq!(colors.background, palette.plate);
            assert_eq!(colors.sidebar, palette.canvas);
            assert_eq!(colors.popover, palette.overlay);
            assert_eq!(colors.foreground, palette.ink);
            assert_eq!(colors.muted_foreground, palette.ink_muted);
            assert_eq!(colors.ring, palette.accent, "the focus ring is Maka's accent");
            assert_eq!(colors.accent, palette.hover, "kit accent is the hover wash");
            assert_eq!(colors.primary, palette.primary);
            assert_eq!(colors.primary_foreground, palette.on_primary);
            assert_eq!(colors.danger, palette.destructive);
            assert_eq!(colors.info, palette.accent, "no second blue for info");
            assert_eq!(colors.list_active, palette.active_row);
            assert_eq!(colors.scrollbar_thumb, palette.border_strong);
            assert_eq!(colors.button_hover.a, 1., "button fills stay opaque");
        }
    }

    #[test]
    fn a_disabled_switch_rings_its_thumb_where_the_thumb_is_the_surface() {
        let light = MakaPalette::light();
        // Light: the white thumb on the white plate takes the off track's
        // hairline, so it reads as a switch, not as a missing one.
        assert_eq!(super::disabled_thumb_ring(&light, false), Some(light.border_strong));
        // Dark: the thumb is ink, its own edge.
        assert_eq!(super::disabled_thumb_ring(&MakaPalette::dark(), true), None);
    }

    #[test]
    fn the_default_palette_is_the_reviewed_one() {
        let default = |mode| MakaPalette::for_palette(ThemePalette::Default, mode);
        assert_eq!(default(ThemeMode::Light), MakaPalette::light());
        assert_eq!(default(ThemeMode::Dark), MakaPalette::dark());
        for palette in ThemePalette::ALL {
            assert_eq!(
                MakaPalette::for_palette(palette, ThemeMode::Dark),
                palette::resolve(palette, true),
                "the table is indexed in ALL's order"
            );
        }
    }

    #[gpui_kit::test]
    fn choosing_a_palette_repaints_the_kit_theme(cx: &mut gpui_kit::TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            apply_kit_theme(cx);
        });
        // The kit's plate, sidebar, primary and focus ring (with the tokens
        // that follow them), and the roles views read.
        let painted = |cx: &mut gpui_kit::TestAppContext| {
            cx.update(|cx| {
                let theme = Theme::global(cx);
                assert_eq!(theme.tokens.background.color, theme.background, "tokens follow");
                ([theme.background, theme.sidebar, theme.primary, theme.ring], cx.maka())
            })
        };
        let expected = |palette: MakaPalette| {
            ([palette.plate, palette.canvas, palette.primary, palette.accent], palette)
        };
        let default = MakaPalette::light();
        assert_eq!(painted(cx), expected(default), "the default until one is chosen");

        cx.update(|cx| set_theme_palette(ThemePalette::Nord, cx));
        let nord = MakaPalette::for_palette(ThemePalette::Nord, ThemeMode::Light);
        assert_eq!(cx.update(|cx| theme_palette(cx)), ThemePalette::Nord);
        assert_eq!(painted(cx), expected(nord));
        for (nord, default) in expected(nord).0.into_iter().zip(expected(default).0) {
            assert_ne!(nord, default, "every mapped role changes");
        }

        // An appearance change keeps the palette.
        cx.update(|cx| {
            Theme::change(ThemeMode::Dark, None, cx);
            apply_kit_theme(cx);
        });
        assert_eq!(
            painted(cx),
            expected(MakaPalette::for_palette(ThemePalette::Nord, ThemeMode::Dark))
        );

        cx.update(|cx| set_theme_palette(ThemePalette::Default, cx));
        assert_eq!(painted(cx), expected(MakaPalette::dark()), "and back");
    }

    #[gpui_kit::test]
    fn the_ui_font_size_sets_the_rem_and_outlasts_an_appearance_change(
        cx: &mut gpui_kit::TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            apply_kit_theme(cx);
        });
        let rem = |cx: &mut gpui_kit::TestAppContext| cx.update(|cx| Theme::global(cx).font_size);
        assert_eq!(rem(cx), px(16.), "gpui-kit's rem at the default size");
        cx.update(|cx| set_ui_font_size(21, cx));
        assert_eq!(cx.update(|cx| ui_font_size(cx)), 21);
        assert_eq!(rem(cx), px(24.), "body text, 0.875rem, is 21px");
        cx.update(|cx| {
            Theme::change(ThemeMode::Dark, None, cx);
            apply_kit_theme(cx);
        });
        assert_eq!(rem(cx), px(24.));
    }
}

/// What a control sits on, for a fade that blends toward it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// The main reading plate: settings pages and the main-area pages.
    Plate,
    /// A dialog, menu or popover.
    Overlay,
}

/// The strength a disabled control is drawn at: Astryx's disabled recipe
/// (`opacity: 0.5` on the whole control), which the kit's own disabled
/// colours do not reach where a control sets its own ink.
pub const DISABLED_OPACITY: f32 = 0.5;

/// gpui-kit's switch, drawn whole at half strength while disabled, as
/// Astryx's `trackDisabled` (the control at opacity 0.5). The kit fades the
/// track alone, which leaves the thumb at full strength, so a disabled off
/// switch read as an enabled one in dark (review rounds 12 and 13). GPUI's
/// opacity multiplies each primitive rather than the group, so a fade of
/// the whole would let the track show through the thumb; instead a disc of
/// the surface at half strength covers the thumb, which lands on the pixels
/// a grouped fade would. `checked` and `disabled` are what the switch was
/// given; it is the kit's default size (36 by 20, a 16px thumb inset 2) and
/// carries no label.
#[derive(gpui_kit::IntoElement)]
pub struct FadedSwitch {
    switch: gpui_kit::component::switch::Switch,
    checked: bool,
    disabled: bool,
    surface: Surface,
}

impl std::fmt::Debug for FadedSwitch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FadedSwitch")
            .field("checked", &self.checked)
            .field("disabled", &self.disabled)
            .field("surface", &self.surface)
            .finish_non_exhaustive()
    }
}

impl FadedSwitch {
    pub fn new(switch: gpui_kit::component::switch::Switch, checked: bool, disabled: bool) -> Self {
        Self { switch, checked, disabled, surface: Surface::Plate }
    }

    /// The surface the switch sits on (the plate unless said).
    pub fn on(mut self, surface: Surface) -> Self {
        self.surface = surface;
        self
    }
}

impl gpui_kit::RenderOnce for FadedSwitch {
    fn render(self, _: &mut gpui_kit::Window, cx: &mut App) -> impl IntoElement {
        const INSET: Pixels = px(2.);
        const THUMB: Pixels = px(16.);
        const TRAVEL: Pixels = px(16.);
        let palette = cx.maka();
        let surface = match self.surface {
            Surface::Plate => palette.plate,
            Surface::Overlay => palette.overlay,
        };
        let ring = disabled_thumb_ring(&palette, cx.theme().is_dark());
        div().relative().flex_shrink_0().child(self.switch).when(self.disabled, |this| {
            this.child(
                div()
                    .absolute()
                    .top(INSET)
                    .left(INSET + if self.checked { TRAVEL } else { px(0.) })
                    .size(THUMB)
                    .rounded_full()
                    .bg(surface.opacity(DISABLED_OPACITY))
                    .when_some(ring, |this, ring| this.border_1().border_color(ring)),
            )
        })
    }
}

/// The ring a disabled switch's thumb takes. In light the thumb is the
/// plate's white, so faded on its faded track it vanished and the switch
/// read as missing (review round 14): a hairline in the off track's colour
/// draws its edge. In dark the thumb is ink and stands out without one.
fn disabled_thumb_ring(palette: &MakaPalette, dark: bool) -> Option<Hsla> {
    (!dark).then_some(palette.border_strong)
}
