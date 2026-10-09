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

//! The pieces of a divided list that settings pages and the main window's
//! pages share, after Desktop's rows.css: the rule between rows, a filled
//! row's corners, the one inline empty state, the inline status line, and
//! the one form field ([`FieldBlock`]), which the main window's dialogs
//! take too. Rows sit on the column's edges; the rule spans the column and
//! is drawn between rows only.

use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, InteractiveElement as _, IntoElement, ParentElement, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, rems,
};

use crate::copy::settings as copy;
use crate::domain_element_id;
use crate::icons::MakaIcon;
use crate::theme::{ActiveMakaPalette as _, RADIUS_SURFACE};

/// Supporting text: 12px on 20px lines.
const SUPPORTING_LINE_REMS: f32 = 1.25;

/// The hairline between two rows of a divided list built outside a
/// settings group: `border_soft`, the column's full width (the rows
/// span the column; Desktop's rows.css draws it on rows 2..n).
pub fn row_rule(cx: &App) -> AnyElement {
    div().h_px().w_full().flex_shrink_0().bg(cx.maka().border_soft).into_any_element()
}

/// A row with a hover or selected fill, at `ix` of `len` in a divided
/// list: the fill spans the column and is square, except for the group's
/// outer corners, which the first row's top and the last row's bottom take
/// (Desktop's rows.css), so a filled end row does not paint a square corner
/// into the page. Its content sits on the column's edges like a
/// settings row's.
pub fn list_row<E: Styled>(row: E, ix: usize, len: usize) -> E {
    let mut row = row.rounded_none();
    if ix == 0 {
        row = row.rounded_t(RADIUS_SURFACE);
    }
    if ix + 1 == len {
        row = row.rounded_b(RADIUS_SURFACE);
    }
    row
}

/// What a group with no rows yet says, in place of its rows: one line of
/// supporting text (12 muted) in a 32px row, on the column's edge like a
/// row's title.
/// The one inline empty state; a page with nothing at all to show takes
/// the centred one (settings' `page_kit::empty_state`). Its element is
/// `domain_element_id("settings-empty", key)`, named by the text.
#[derive(IntoElement)]
pub struct EmptyRow {
    key: SharedString,
    text: SharedString,
}

impl std::fmt::Debug for EmptyRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmptyRow").field("key", &self.key).field("text", &self.text).finish()
    }
}

impl EmptyRow {
    pub fn new(key: impl Into<SharedString>, text: impl Into<SharedString>) -> Self {
        Self { key: key.into(), text: text.into() }
    }
}

impl RenderOnce for EmptyRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        h_flex()
            .id(domain_element_id("settings-empty", &self.key))
            .test_support()
            .aria_label(self.text.clone())
            .w_full()
            .min_h_8()
            .py_1p5()
            .text_xs()
            .line_height(rems(SUPPORTING_LINE_REMS))
            .text_color(cx.maka().ink_muted)
            .child(self.text)
    }
}

/// What an inline status line says: a plain fact, or what went wrong (in
/// the destructive ink, after the failed glyph, so it never rests on
/// colour alone).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum StatusKind {
    Info,
    Error,
}

/// One line of status under a row's detail, or on its own in a group: why
/// a setting cannot change now, or why a change failed, with an optional
/// control after it (Retry).
#[derive(IntoElement)]
pub struct StatusLine {
    key: SharedString,
    kind: StatusKind,
    message: SharedString,
    action: Option<AnyElement>,
    centred: bool,
}

impl std::fmt::Debug for StatusLine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StatusLine")
            .field("key", &self.key)
            .field("kind", &self.kind)
            .field("message", &self.message)
            .finish_non_exhaustive()
    }
}

impl StatusLine {
    /// A line for the setting `key`: `domain_element_id("settings-status", key)`,
    /// named by its message.
    pub fn new(
        key: impl Into<SharedString>,
        kind: StatusKind,
        message: impl Into<SharedString>,
    ) -> Self {
        Self { key: key.into(), kind, message: message.into(), action: None, centred: false }
    }

    pub fn error(key: impl Into<SharedString>, message: impl Into<SharedString>) -> Self {
        Self::new(key, StatusKind::Error, message)
    }

    pub fn info(key: impl Into<SharedString>, message: impl Into<SharedString>) -> Self {
        Self::new(key, StatusKind::Info, message)
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.action = Some(action.into_any_element());
        self
    }

    /// The line centred on its action rather than on the action's top, for
    /// a sentence that fits on one line beside its button.
    pub fn centred(mut self) -> Self {
        self.centred = true;
        self
    }
}

impl RenderOnce for StatusLine {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let maka = cx.maka();
        let (ink, glyph) = match self.kind {
            StatusKind::Error => (maka.destructive, Some(MakaIcon::StatusFailed)),
            StatusKind::Info => (maka.ink_muted, None),
        };
        h_flex()
            .id(domain_element_id("settings-status", &self.key))
            .test_support()
            .aria_label(self.message.clone())
            .w_full()
            .map(|this| if self.centred { this.items_center() } else { this.items_start() })
            .gap_1p5()
            .text_xs()
            .line_height(rems(SUPPORTING_LINE_REMS))
            .text_color(ink)
            .children(glyph.map(|glyph| {
                // Centred on the first line.
                h_flex()
                    .h(rems(SUPPORTING_LINE_REMS))
                    .child(Icon::new(glyph).size_3().text_color(ink))
            }))
            .child(div().flex_1().min_w_0().child(self.message))
            .children(self.action)
    }
}

/// What a form field's label says after its name, as Desktop's Astryx
/// `FieldLabel` marks it (" ∙ Required", " ∙ Optional"), on the forms
/// that mark them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum FieldMark {
    Required,
    Optional,
}

/// A full-width block of labeled controls among a group's rows (Desktop's
/// `SettingsField`), the one form field recipe of settings: each control
/// under its label (14/500 ink, a [`FieldMark`] after it at 12 muted), 8px
/// above the 32px field; several controls sit side by side and wrap when
/// narrow. A help line (12/20 muted) 8px under the field, a status line,
/// and the block's buttons at its end. Flush with the column, 8px above and
/// below, so consecutive blocks (see settings' `SettingsGroup::field`) are 16px
/// apart. Its element is `domain_element_id("settings-field", key)`.
#[derive(IntoElement)]
pub struct FieldBlock {
    domain: &'static str,
    key: SharedString,
    fields: Vec<(SharedString, Option<FieldMark>, AnyElement)>,
    help: Option<AnyElement>,
    status: Option<StatusLine>,
    actions: Vec<AnyElement>,
}

impl std::fmt::Debug for FieldBlock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FieldBlock").field("key", &self.key).finish_non_exhaustive()
    }
}

impl FieldBlock {
    pub fn new(key: impl Into<SharedString>) -> Self {
        Self {
            domain: "settings-field",
            key: key.into(),
            fields: Vec::new(),
            help: None,
            status: None,
            actions: Vec::new(),
        }
    }

    /// The block's element is `domain_element_id(domain, key)` instead of
    /// a settings field's (a dialog's form outside settings).
    pub fn domain(mut self, domain: &'static str) -> Self {
        self.domain = domain;
        self
    }

    /// A control under its `label`; an empty label draws none.
    pub fn field(mut self, label: impl Into<SharedString>, control: impl IntoElement) -> Self {
        self.fields.push((label.into(), None, control.into_any_element()));
        self
    }

    /// Marks the last control's label required (when `required`).
    pub fn required(self, required: bool) -> Self {
        self.mark(required.then_some(FieldMark::Required))
    }

    /// Marks the last control's label optional (when `optional`).
    pub fn optional(self, optional: bool) -> Self {
        self.mark(optional.then_some(FieldMark::Optional))
    }

    fn mark(mut self, mark: Option<FieldMark>) -> Self {
        if let (Some(mark), Some(field)) = (mark, self.fields.last_mut()) {
            field.1 = Some(mark);
        }
        self
    }

    /// The line under the controls: what they take. The one caption
    /// recipe under form fields: 12/20 muted, 8px below the field.
    pub fn help(mut self, help: impl Into<SharedString>) -> Self {
        self.help = Some(div().child(help.into()).into_any_element());
        self
    }

    /// A help line that is more than text (a sentence with a link), in
    /// the help line's place and type.
    pub fn help_element(mut self, help: impl IntoElement) -> Self {
        self.help = Some(help.into_any_element());
        self
    }

    pub fn status(mut self, status: impl Into<Option<StatusLine>>) -> Self {
        self.status = status.into();
        self
    }

    /// A button at the block's end (Save, Cancel), 8px apart.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

impl RenderOnce for FieldBlock {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let maka = cx.maka();
        let fields = self.fields.into_iter().map(|(label, mark, control)| {
            let mark = mark.map(|mark| {
                let word = match mark {
                    FieldMark::Required => copy::REQUIRED,
                    FieldMark::Optional => copy::OPTIONAL,
                };
                div()
                    .text_xs()
                    .font_weight(gpui_kit::FontWeight::NORMAL)
                    .text_color(maka.ink_muted)
                    .child(format!("∙ {}", word.get(cx)))
            });
            v_flex()
                .flex_1()
                .min_w(rems(8.))
                .gap_2()
                .when(!label.is_empty(), |this| {
                    this.child(
                        h_flex()
                            .items_baseline()
                            .gap_1()
                            .text_sm()
                            .line_height(rems(SUPPORTING_LINE_REMS))
                            .font_weight(gpui_kit::FontWeight::MEDIUM)
                            .text_color(maka.ink)
                            .child(label)
                            .children(mark),
                    )
                })
                .child(control)
        });
        v_flex()
            .id(domain_element_id(self.domain, &self.key))
            .test_support()
            .w_full()
            .py_2()
            .gap_2()
            .child(h_flex().w_full().items_start().flex_wrap().gap_3().children(fields))
            .children(self.help.map(|help| {
                div()
                    .w_full()
                    .text_xs()
                    .line_height(rems(SUPPORTING_LINE_REMS))
                    .text_color(maka.ink_muted)
                    .child(help)
            }))
            .children(self.status)
            .when(!self.actions.is_empty(), |this| {
                this.child(
                    h_flex().w_full().justify_end().flex_wrap().gap_2().children(self.actions),
                )
            })
    }
}
