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

//! The row kit every settings page is built from, after Maka Desktop's
//! (`SettingsSection`, `SettingsRow`, `SettingsActions` in
//! apps/desktop/src/renderer/application/contracts/settings-presentation/settings-section.tsx,
//! `SettingRow` in settings-rows.tsx, `SettingsRowSkeleton` in
//! settings-skeleton.tsx; geometry in styles/settings/rows.css and
//! nav-sidebar.css).
//!
//! A page is a list of [`SettingsGroup`]s: a heading (16/600) with an
//! optional line under it (12 muted), a `border_soft` rule, then rows split
//! by the same rule. A [`SettingsRow`] has a title (14/500), an optional
//! detail (12 muted), and an end slot for its control or value, at most
//! 320px wide; machine text (a path, an id) goes on its own full-width mono
//! line under the detail instead, and an inline [`StatusLine`] under that.
//! The constructors ([`SettingsRow::toggle`], [`SettingsRow::select`],
//! [`SettingsRow::text`], [`SettingsRow::value`], [`SettingsRow::path`],
//! [`SettingsRow::loading`]) put the usual controls in it; [`ActionRow`]
//! holds a group's buttons ([`settings_button`], [`destructive_button`]).
//! [`TextSetting`] is the text field that commits on Enter or blur and puts
//! back the committed value on Escape.
//!
//! Every element takes its id from a key the page chooses, so tests and
//! focus follow the setting, not its position.

use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::select::{Select, SelectDelegate, SelectItem, SelectState};
use gpui_kit::component::skeleton::Skeleton;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, KeyBinding, ParentElement, Render, RenderOnce,
    Role, SharedString, StatefulInteractiveElement as _, Styled, Subscription, TestSupportExt as _,
    Window, div, prelude::FluentBuilder as _, rems,
};
use shared::copy::Text;
use shared::copy::settings as copy;
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FadedSwitch;
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS, quiet_button};

/// The widest a row's end slot grows: Desktop's `--settings-row-end-cap`,
/// so a wide control wraps before it crushes the title.
const ROW_END_MAX_WIDTH_REMS: f32 = 20.;

/// The one width of a select in a settings row: Desktop's
/// `--settings-control-width` (260px), so the selects of a page end and
/// start on one column whatever their choices say.
pub(crate) const SETTINGS_CONTROL_WIDTH_REMS: f32 = 16.25;

/// Supporting text (details, descriptions, status): 12px on 20px lines.
const SUPPORTING_LINE_REMS: f32 = 1.25;

/// Key context of a [`TextSetting`]'s field: Escape puts back the value.
pub const TEXT_SETTING_CONTEXT: &str = "SettingsTextField";

gpui_kit::actions!(
    settings_rows,
    [
        /// Put the committed value back in the field being edited.
        RevertTextSetting,
    ]
);

/// Binds a text setting's Escape. Called by [`crate::init`].
pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", RevertTextSetting, Some(TEXT_SETTING_CONTEXT))]);
}

/// A labeled group of settings (Desktop's `SettingsSection`): the heading,
/// its description, and an action at the heading's end (Add…, Refresh),
/// then its rows, each under a `border_soft` rule. A [`bare`](Self::bare)
/// group holds content that is not rows (a grid of options, a list pane)
/// and draws no rules between its children.
#[derive(IntoElement)]
pub struct SettingsGroup {
    key: &'static str,
    title: Option<SharedString>,
    description: Option<SharedString>,
    action: Option<AnyElement>,
    lead: Option<AnyElement>,
    /// A row over the lead, under the heading's rule.
    above_lead: Option<AnyElement>,
    bare: bool,
    intro: bool,
    /// Each child, and what it is to the rules (see [`Self::field`] and
    /// [`Self::follow`]).
    children: Vec<(AnyElement, Child)>,
}

/// What a group's child is to the rules between its children.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Child {
    Row,
    Field,
    /// Goes on from the child before it: no rule between them.
    Follow,
}

impl std::fmt::Debug for SettingsGroup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsGroup").field("key", &self.key).finish_non_exhaustive()
    }
}

impl SettingsGroup {
    /// A group identified by `key`: its element is
    /// `domain_element_id("settings-group", key)`, its heading
    /// `domain_element_id("settings-group-title", key)`.
    pub fn new(key: &'static str) -> Self {
        Self {
            key,
            title: None,
            description: None,
            action: None,
            lead: None,
            above_lead: None,
            bare: false,
            intro: false,
            children: Vec::new(),
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// The quiet line under the heading: what the group governs.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// One group-level control at the heading's end.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    /// A block that stands on its own between the heading and the rows (an
    /// inline form on its plate): it takes the place of the heading's rule,
    /// which a bordered block would double.
    pub fn lead(mut self, lead: impl IntoElement) -> Self {
        self.lead = Some(lead.into_any_element());
        self
    }

    /// A row that comes before the [`Self::lead`] (Desktop renders the
    /// unfinished pairing before the add form): under the heading's rule,
    /// with the lead under it.
    pub fn above_lead(mut self, row: impl IntoElement) -> Self {
        self.above_lead = Some(row.into_any_element());
        self
    }

    /// Content that is not a list of rows: no rules between its children,
    /// 12px apart.
    pub fn bare(mut self) -> Self {
        self.bare = true;
        self
    }

    /// The page's first group, which Desktop gives no heading: its
    /// description reads as the page's intro (body text, no rule under
    /// it) rather than as the caption of a group whose title is missing.
    pub fn intro(mut self) -> Self {
        self.intro = true;
        self
    }

    /// A form block among the rows. Consecutive blocks are one form: 16px
    /// apart with no rule between them; a rule still parts a block from a
    /// row.
    pub fn field(mut self, block: impl Into<Option<FieldBlock>>) -> Self {
        if let Some(block) = block.into() {
            self.children.push((block.into_any_element(), Child::Field));
        }
        self
    }

    /// A child that goes on from the one before it (a list's sub-header
    /// under the filter that narrows it): no rule between the two, which
    /// the sub-header's own spacing parts.
    pub fn follow(mut self, child: impl IntoElement) -> Self {
        self.children.push((child.into_any_element(), Child::Follow));
        self
    }
}

impl ParentElement for SettingsGroup {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements.into_iter().map(|element| (element, Child::Row)));
    }
}

impl RenderOnce for SettingsGroup {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let maka = cx.maka();
        let rule = move || div().h_px().w_full().flex_shrink_0().bg(maka.border_soft);
        let has_header =
            self.title.is_some() || self.description.is_some() || self.action.is_some();
        // A group with nothing under its heading (a collapsed one) draws no
        // rule over nothing (review round 11).
        let has_body = !self.children.is_empty() || self.lead.is_some();
        // A heading's line sits under the title, so the action meets the
        // title; a group with no title centres its line on its action.
        let titled = self.title.is_some();
        let header = has_header.then(|| {
            h_flex()
                .w_full()
                .map(|this| if titled { this.items_start() } else { this.items_center() })
                .justify_between()
                .flex_wrap()
                .gap_3()
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap_0p5()
                        .children(self.title.map(|title| {
                            div()
                                .id(domain_element_id("settings-group-title", self.key))
                                .test_support()
                                .role(Role::Heading)
                                .aria_label(title.clone())
                                .text_size(rems(HEADING_TEXT_REMS))
                                .line_height(rems(HEADING_LINE_REMS))
                                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                                .text_color(maka.ink)
                                .child(title)
                        }))
                        .children(self.description.map(|description| {
                            div()
                                .id(domain_element_id("settings-group-description", self.key))
                                .test_support()
                                .aria_label(description.clone())
                                .map(
                                    |this| if self.intro { this.text_sm() } else { this.text_xs() },
                                )
                                .line_height(rems(SUPPORTING_LINE_REMS))
                                .text_color(maka.ink_muted)
                                .child(description)
                        })),
                )
                .children(self.action)
        });
        let body = if self.bare {
            v_flex().w_full().gap_3().children(self.children.into_iter().map(|(child, _)| child))
        } else {
            // Rules part rows 2..n from the one before (Desktop's
            // `.settingsRows > * + *`), never after the last; consecutive
            // form blocks are one form, and a following child goes on from
            // its predecessor.
            let mut rows = Vec::with_capacity(self.children.len() * 2);
            let mut previous = None;
            for (child, kind) in self.children {
                match (previous, kind) {
                    (None, _) | (_, Child::Follow) | (Some(Child::Field), Child::Field) => {}
                    _ => rows.push(rule().into_any_element()),
                }
                previous = Some(kind);
                rows.push(child);
            }
            v_flex().w_full().children(rows)
        };
        v_flex()
            .id(domain_element_id("settings-group", self.key))
            .test_support()
            .w_full()
            .gap_2()
            .when_some(header, |this, header| {
                this.child(header).when(
                    !self.intro && (self.lead.is_none() || self.above_lead.is_some()) && has_body,
                    |this| this.child(rule()),
                )
            })
            .when_some(self.lead, |this, lead| {
                this.child(
                    v_flex()
                        .w_full()
                        .children(self.above_lead)
                        .child(div().w_full().pt_1().pb_2().child(lead)),
                )
            })
            .child(body)
    }
}

/// One setting (Desktop's `SettingsRow` and `SettingRow`): the title, the
/// detail under it, the end slot, and optionally a full-width mono value
/// and a status line under the detail. Its element is
/// `domain_element_id("settings-row", key)`, named by the title.
#[derive(IntoElement)]
pub struct SettingsRow {
    key: SharedString,
    title: SharedString,
    detail: Option<SharedString>,
    detail_element: Option<AnyElement>,
    mono: Option<SharedString>,
    status: Option<StatusLine>,
    end: Vec<AnyElement>,
    align_start: bool,
}

impl std::fmt::Debug for SettingsRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsRow").field("key", &self.key).finish_non_exhaustive()
    }
}

impl SettingsRow {
    pub fn new(key: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        Self {
            key: key.into(),
            title: title.into(),
            detail: None,
            detail_element: None,
            mono: None,
            status: None,
            end: Vec::new(),
            align_start: false,
        }
    }

    /// The line under the title: what the setting does. It wraps.
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// An element under the title in the detail's place (a status: the
    /// dot and its words).
    pub fn detail_element(mut self, detail: impl IntoElement) -> Self {
        self.detail_element = Some(detail.into_any_element());
        self
    }

    /// A control (or several, 8px apart) at the row's end.
    pub fn end(mut self, end: impl IntoElement) -> Self {
        self.end.push(end.into_any_element());
        self
    }

    /// The end slot centred on the row, as a trailing label sits, where
    /// the row's constructor would put it on the title's line (a
    /// [`path`](Self::path) row's).
    pub fn centred(mut self) -> Self {
        self.align_start = false;
        self
    }

    /// A status line under the detail.
    pub fn status(mut self, status: impl Into<Option<StatusLine>>) -> Self {
        self.status = status.into();
        self
    }

    /// A switch: `on_change` gets the value asked for, and the owner writes
    /// it (the switch shows `checked` until then).
    pub fn toggle(
        key: impl Into<SharedString>,
        title: impl Into<SharedString>,
        checked: bool,
        disabled: bool,
        on_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        let key = key.into();
        let title = title.into();
        let switch = FadedSwitch::new(
            Switch::new(domain_element_id("settings-toggle", &key))
                .checked(checked)
                .disabled(disabled)
                .accessibility_label(title.clone())
                .on_change(on_change),
            checked,
            disabled,
        );
        Self::new(key, title).end(switch)
    }

    /// A kit dropdown the owner builds from its own `SelectState` (so it
    /// keeps the choices and the selection), [`SETTINGS_CONTROL_WIDTH_REMS`]
    /// wide; the row names it by its title.
    pub fn select<D: SelectDelegate + 'static>(
        key: impl Into<SharedString>,
        title: impl Into<SharedString>,
        select: Select<D>,
    ) -> Self
    where
        <D::Item as SelectItem>::Value: PartialEq + Clone,
    {
        let key = key.into();
        let title = title.into();
        let select = select
            .id(domain_element_id("settings-select", &key))
            .accessibility_label(title.clone())
            .w(rems(SETTINGS_CONTROL_WIDTH_REMS))
            .max_w_full();
        Self::new(key, title).end(select)
    }

    /// A text field that commits on Enter or blur (see [`TextSetting`]).
    pub fn text(
        key: impl Into<SharedString>,
        title: impl Into<SharedString>,
        field: &Entity<TextSetting>,
    ) -> Self {
        Self::new(key, title).end(div().w(rems(ROW_END_MAX_WIDTH_REMS)).child(field.clone()))
    }

    /// A short value read out at the row's end, right-aligned; its element
    /// is `domain_element_id("settings-value", key)`, named by the value.
    pub fn value(
        key: impl Into<SharedString>,
        title: impl Into<SharedString>,
        value: impl Into<SharedString>,
        cx: &App,
    ) -> Self {
        let key = key.into();
        let value = value.into();
        let element = div()
            .id(domain_element_id("settings-value", &key))
            .test_support()
            .aria_label(value.clone())
            .min_w_0()
            .text_sm()
            .text_color(cx.maka().ink_muted)
            .text_right()
            .child(value);
        let mut row = Self::new(key, title).end(element);
        row.align_start = true;
        row
    }

    /// Machine text (a path, an id) on its own full-width mono line under
    /// the detail, where a long value wraps instead of squeezing into the
    /// end slot; its element is `domain_element_id("settings-value", key)`.
    pub fn path(
        key: impl Into<SharedString>,
        title: impl Into<SharedString>,
        value: impl Into<SharedString>,
    ) -> Self {
        let mut row = Self::new(key, title);
        row.mono = Some(value.into());
        row.align_start = true;
        row
    }

    /// The row while its value loads: the title and detail stay readable and
    /// a placeholder `width` rems wide holds the control's place, announced
    /// as loading.
    pub fn loading(
        key: impl Into<SharedString>,
        title: impl Into<SharedString>,
        width: f32,
        cx: &App,
    ) -> Self {
        let key = key.into();
        let placeholder = div()
            .id(domain_element_id("settings-loading", &key))
            .test_support()
            .aria_label(copy::SETTINGS_LOADING.get(cx))
            .child(Skeleton::new().h_7().w(rems(width)).rounded(cx.theme().radius));
        Self::new(key, title).end(placeholder)
    }
}

impl RenderOnce for SettingsRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let maka = cx.maka();
        let mono = self.mono.map(|value| {
            div()
                .id(domain_element_id("settings-value", &self.key))
                .test_support()
                .aria_label(value.clone())
                .w_full()
                .font_family(cx.theme().mono_font_family.clone())
                // Compact code, 12/20: machine text sits below the title's
                // rung (review round 9).
                .text_xs()
                .line_height(rems(SUPPORTING_LINE_REMS))
                .text_color(maka.ink_muted)
                .child(value)
        });
        h_flex()
            .id(domain_element_id("settings-row", &self.key))
            .test_support()
            .aria_label(self.title.clone())
            .w_full()
            .map(|this| if self.align_start { this.items_start() } else { this.items_center() })
            .gap_4()
            .py_2()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(maka.ink)
                            .child(self.title),
                    )
                    .children(self.detail.map(|detail| {
                        div()
                            .text_xs()
                            .line_height(rems(SUPPORTING_LINE_REMS))
                            .text_color(maka.ink_muted)
                            .child(detail)
                    }))
                    .children(self.detail_element)
                    .children(mono)
                    .children(self.status.map(|status| div().pt_0p5().child(status))),
            )
            .when(!self.end.is_empty(), |this| {
                this.child(
                    h_flex()
                        .flex_shrink_0()
                        .max_w(rems(ROW_END_MAX_WIDTH_REMS))
                        .justify_end()
                        .flex_wrap()
                        .gap_2()
                        .children(self.end),
                )
            })
    }
}

/// The one filter field of settings (the provider catalog's search,
/// Memory's filter, a connection's model filter): the column's full
/// width, the search glyph, and a clear button while it holds text, in
/// the field fill. The caller sets nothing else but its place.
pub fn filter_field(
    state: &Entity<InputState>,
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    cx: &App,
) -> Input {
    Input::new(state)
        .field_fill(cx)
        .id(id)
        .aria_label(label.into())
        .prefix(Icon::new(MakaIcon::Search).small())
        .cleanable(true)
}

pub use shared::rows::{
    EmptyRow, FieldBlock, FieldMark, StatusKind, StatusLine, list_row, row_rule,
};

/// A group's trailing cluster of buttons (Desktop's `SettingsActions`):
/// flush with the heading, 12px above and below, 8px apart, wrapping.
#[derive(IntoElement)]
pub struct ActionRow {
    key: &'static str,
    children: Vec<AnyElement>,
}

impl std::fmt::Debug for ActionRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActionRow").field("key", &self.key).finish_non_exhaustive()
    }
}

impl ActionRow {
    /// `domain_element_id("settings-actions", key)`.
    pub fn new(key: &'static str) -> Self {
        Self { key, children: Vec::new() }
    }
}

impl ParentElement for ActionRow {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for ActionRow {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        h_flex()
            .id(domain_element_id("settings-actions", self.key))
            .test_support()
            .w_full()
            .flex_wrap()
            .gap_2()
            .py_3()
            .children(self.children)
    }
}

/// A settings action: Desktop's row action at Maka's control size, the ink
/// label on the ink 6% wash (see [`quiet_button`]). Every labeled action
/// of a row, a group's action row and an inline form takes it, so a page
/// has one quiet button beside its one primary.
pub fn settings_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    cx: &App,
) -> Button {
    quiet_button(Button::new(id), cx).label(label)
}

/// An action that removes or clears something that cannot come back: the
/// destructive ink on a soft wash of it, as Desktop's "清空输入历史". The
/// label says what goes; a destructive action that deserves a question
/// asks it inline before it acts.
pub fn destructive_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    cx: &App,
) -> Button {
    shared::theme::destructive_button(Button::new(id), cx).label(label)
}

/// One option of a settings dropdown: the value it sets and its label.
#[derive(Debug, Clone, PartialEq)]
pub struct Choice<V> {
    value: V,
    label: SharedString,
}

impl<V> Choice<V> {
    pub fn new(value: V, label: impl Into<SharedString>) -> Self {
        Self { value, label: label.into() }
    }
}

impl<V: Clone + PartialEq + 'static> SelectItem for Choice<V> {
    type Value = V;

    fn title(&self) -> SharedString {
        self.label.clone()
    }

    fn value(&self) -> &V {
        &self.value
    }
}

/// The state of a settings dropdown over [`Choice`]s, which its owner
/// creates once and keeps; [`sync_choices`] brings it up to date.
pub type ChoiceSelect<V> = SelectState<Vec<Choice<V>>>;

/// Gives `select` these `choices` (their labels in the current language)
/// with `selected` chosen, or none. For the owner's observers of the
/// setting and of the language, never for render.
pub fn sync_choices<V: Clone + PartialEq + 'static>(
    select: &Entity<ChoiceSelect<V>>,
    choices: Vec<Choice<V>>,
    selected: Option<&V>,
    window: &mut Window,
    cx: &mut App,
) {
    select.update(cx, |select, cx| {
        select.set_items(choices, window, cx);
        match selected {
            Some(value) => select.set_selected_value(value, window, cx),
            None => select.set_selected_index(None, window, cx),
        }
    });
}

/// What a [`TextSetting`] reports.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TextSettingEvent {
    /// The field's text changed from the committed value and was committed
    /// (Enter, or the field lost focus); it is now the committed value.
    Committed(SharedString),
}

/// A single-line text setting: the field and the value last committed.
/// Enter or leaving the field commits a changed text (an unchanged one
/// commits nothing); Escape puts the committed value back and stays in the
/// field. The owner saves what is committed and, once the Host answers,
/// hands the stored value back with [`Self::set_committed`].
pub struct TextSetting {
    label: Text,
    input: Entity<InputState>,
    committed: SharedString,
    disabled: bool,
    _subscription: Subscription,
}

impl std::fmt::Debug for TextSetting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TextSetting").field("committed", &self.committed).finish_non_exhaustive()
    }
}

impl EventEmitter<TextSettingEvent> for TextSetting {}

impl TextSetting {
    /// A field named `label` holding `value`.
    pub fn new(
        label: Text,
        value: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let committed = value.into();
        let input = cx.new(|cx| InputState::new(window, cx).default_value(committed.clone()));
        let subscription = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                this.commit(cx);
            }
        });
        Self { label, input, committed, disabled: false, _subscription: subscription }
    }

    pub fn input(&self) -> &Entity<InputState> {
        &self.input
    }

    /// The value last committed.
    pub fn committed(&self) -> &SharedString {
        &self.committed
    }

    /// Takes `value` as the committed value (the Host's): the field shows it
    /// unless it is being edited, which keeps the text being typed.
    pub fn set_committed(
        &mut self,
        value: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let value = value.into();
        let editing = self.input.read(cx).focus_handle(cx).is_focused(window);
        if !editing && self.input.read(cx).value() != value {
            self.input.update(cx, |input, cx| input.set_value(value.clone(), window, cx));
        }
        if self.committed != value {
            self.committed = value;
            cx.notify();
        }
    }

    /// Puts `value` in the field and takes it as the committed value, even
    /// while the field is being edited: a value the owner refused.
    pub fn reset(
        &mut self,
        value: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let value = value.into();
        self.committed = value.clone();
        self.input.update(cx, |input, cx| input.set_value(value, window, cx));
        cx.notify();
    }

    /// Empties the field and the committed value, whether or not the field
    /// is being edited: a password field once its value went to the Host.
    pub fn clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.committed = SharedString::default();
        self.input.update(cx, |input, cx| input.set_value("", window, cx));
        cx.notify();
    }

    /// The text the empty field shows.
    pub fn set_placeholder(
        &mut self,
        placeholder: impl Into<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let placeholder = placeholder.into();
        self.input.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));
    }

    /// Whether the field takes input (off while a save is in flight).
    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        if self.disabled != disabled {
            self.disabled = disabled;
            cx.notify();
        }
    }

    fn commit(&mut self, cx: &mut Context<Self>) {
        let value = self.input.read(cx).value();
        if value != self.committed {
            self.committed = value.clone();
            cx.emit(TextSettingEvent::Committed(value));
            cx.notify();
        }
    }

    fn revert(&mut self, _: &RevertTextSetting, window: &mut Window, cx: &mut Context<Self>) {
        let committed = self.committed.clone();
        self.input.update(cx, |input, cx| {
            input.set_value(committed, window, cx);
        });
    }
}

impl Focusable for TextSetting {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.read(cx).focus_handle(cx)
    }
}

impl Render for TextSetting {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().key_context(TEXT_SETTING_CONTEXT).on_action(cx.listener(Self::revert)).w_full().child(
            Input::new(&self.input)
                .field_fill(cx)
                .id(("settings-text", cx.entity_id()))
                .aria_label(self.label.get(cx))
                .disabled(self.disabled),
        )
    }
}
