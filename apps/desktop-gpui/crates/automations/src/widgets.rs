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

//! The page's small building blocks: a section heading, an empty state, a
//! failure line, rules between rows, a status dot, a fact of the detail,
//! and a dialog's title. Each follows the Extensions page's recipe, so the
//! two pages read alike.

use gpui_kit::component::{Icon, StyledExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement as _, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, div, rems,
};
use shared::copy::{self as shell_copy, Locale};
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS};

use crate::catalog::ActionFailure;
use crate::model::Semantic;

/// The detail's label column (Desktop's 88px).
const FACT_LABEL_WIDTH_REMS: f32 = 5.5;

/// A 16/600 heading.
pub fn heading(id: impl Into<ElementId>, title: &str, cx: &App) -> AnyElement {
    div()
        .id(id.into())
        .test_support()
        .role(Role::Heading)
        .aria_label(title.to_owned())
        // On the column's edge with the page's title, tabs, tiles and
        // rows, as in settings (review round 11).
        .text_size(rems(HEADING_TEXT_REMS))
        .line_height(rems(HEADING_LINE_REMS))
        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
        .text_color(cx.maka().ink)
        .child(title.to_owned())
        .into_any_element()
}

/// A section's label inside a dialog (the detail's Runs): Desktop's
/// `Text type="label" color="secondary"`, 14/500 muted, 16 under what comes
/// before it (the dialog's gap).
pub fn dialog_label(label: &str, cx: &App) -> gpui_kit::Div {
    div().text_sm().font_medium().text_color(cx.maka().ink_muted).child(label.to_owned())
}

/// A quiet line where the page has nothing to list.
pub fn notice(id: &'static str, text: &str, cx: &App) -> AnyElement {
    div()
        .id(id)
        .test_support()
        .aria_label(text.to_owned())
        .text_sm()
        .text_color(cx.maka().ink_muted)
        .child(text.to_owned())
        .into_any_element()
}

/// Desktop's `EmptyState`: an icon, a title, a line, and an action.
pub fn empty_state(
    id: &'static str,
    icon: Icon,
    title: &str,
    body: Option<&str>,
    action: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    v_flex()
        .id(id)
        .test_support()
        .aria_label(title.to_owned())
        .w_full()
        .items_center()
        .py_8()
        .gap_2()
        .child(icon.size_6().text_color(maka.ink_muted))
        .child(div().text_sm().font_medium().child(title.to_owned()))
        .children(body.map(|body| {
            div()
                .max_w(rems(28.))
                .text_center()
                .text_xs()
                .text_color(maka.ink_muted)
                .child(body.to_owned())
        }))
        .children(action)
        .into_any_element()
}

/// A failure's title over why, after the failed glyph, so it never rests
/// on colour alone.
pub fn failure(id: &str, failure: &ActionFailure, cx: &App) -> AnyElement {
    let locale = Locale::current(cx);
    failure_text(id, failure.title.in_locale(locale), failure.reason.in_locale(locale), cx)
}

pub fn failure_text(id: &str, title: &str, reason: &str, cx: &App) -> AnyElement {
    let maka = cx.maka();
    let locale = Locale::current(cx);
    h_flex()
        .id(SharedString::from(id.to_owned()))
        .test_support()
        .aria_label(shell_copy::labeled(locale, title, reason))
        .items_start()
        .gap_1p5()
        .child(
            h_flex()
                .h(rems(1.25))
                .child(Icon::new(MakaIcon::StatusFailed).size_3().text_color(maka.destructive)),
        )
        .child(
            v_flex()
                .min_w_0()
                .child(
                    div()
                        .text_sm()
                        .font_medium()
                        .text_color(maka.destructive)
                        .child(title.to_owned()),
                )
                .child(div().text_xs().text_color(maka.ink_muted).child(reason.to_owned())),
        )
        .into_any_element()
}

/// Rows under one another with the column-wide rule between them.
pub fn rows_with_rules(
    id: impl Into<ElementId>,
    label: &str,
    rows: Vec<AnyElement>,
    cx: &App,
) -> AnyElement {
    let mut children = Vec::with_capacity(rows.len() * 2);
    for (ix, row) in rows.into_iter().enumerate() {
        if ix > 0 {
            children.push(shared::rows::row_rule(cx));
        }
        children.push(row);
    }
    v_flex()
        .id(id.into())
        .test_support()
        .role(Role::List)
        .aria_label(label.to_owned())
        .w_full()
        .children(children)
        .into_any_element()
}

/// Desktop's `StatusDot`: 8px, coloured by what the state means; the row
/// always says the state in words too.
pub fn status_dot(semantic: Semantic, cx: &App) -> AnyElement {
    let maka = cx.maka();
    let colour = match semantic {
        Semantic::Active => maka.accent,
        Semantic::Attention => maka.warning,
        Semantic::Error => maka.destructive,
        Semantic::Neutral => maka.ink_muted,
    };
    h_flex()
        .size_4()
        .flex_shrink_0()
        .justify_center()
        .child(div().size_2().rounded_full().bg(colour))
        .into_any_element()
}

/// One fact of the detail, as a row of Desktop's `MetadataList`: its
/// label in the 88px label column (14/500 muted), its value 16 after, on
/// a 20px line. The facts stack 8 apart ([`fact_list`]).
pub fn fact(key: &'static str, label: &str, value: impl IntoElement, cx: &App) -> AnyElement {
    h_flex()
        .id(key)
        .test_support()
        .aria_label(label.to_owned())
        .w_full()
        .items_start()
        .gap_4()
        .text_sm()
        .line_height(rems(1.25))
        .child(
            div()
                .w(rems(FACT_LABEL_WIDTH_REMS))
                .flex_shrink_0()
                .font_medium()
                .text_color(cx.maka().ink_muted)
                .child(label.to_owned()),
        )
        .child(div().flex_1().min_w_0().child(value))
        .into_any_element()
}

/// The detail's facts, 8 apart (the `MetadataList` row gap).
pub fn fact_list(facts: Vec<AnyElement>) -> AnyElement {
    v_flex().gap_2().children(facts).into_any_element()
}

/// A thin rule across a dialog's content.
pub fn divider(cx: &App) -> AnyElement {
    div().w_full().h_px().flex_shrink_0().bg(cx.maka().border_soft).into_any_element()
}

/// One option of a dropdown: the value it sets and its label.
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

impl<V: Clone + PartialEq + 'static> gpui_kit::component::select::SelectItem for Choice<V> {
    type Value = V;

    fn title(&self) -> SharedString {
        self.label.clone()
    }

    fn value(&self) -> &V {
        &self.value
    }
}

/// A dropdown's state over [`Choice`]s.
pub type ChoiceSelect<V> = gpui_kit::component::select::SelectState<Vec<Choice<V>>>;
