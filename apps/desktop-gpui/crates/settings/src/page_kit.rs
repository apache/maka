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

//! Pieces the Subagents, Memory, and Web Search pages share beyond the row
//! kit: Desktop's empty state, a status with its dot, and the line that
//! says why the Host's settings cannot show (offline, or the policy
//! unread) with Retry.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, BoxShadow, Div, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, div, prelude::FluentBuilder as _, px, rems,
};
use shared::copy::settings as copy;
use shared::copy::{Locale, failure};
use shared::domain_element_id;
use shared::theme::{ActiveMakaPalette as _, RADIUS_SURFACE};
use workspace::HostSession;

use crate::policy::HostPolicy;
use crate::rows::{StatusLine, settings_button};

/// How a status reads (Desktop's `StatusSemantic`): working, needing
/// attention, failed, or a settled fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tone {
    Success,
    Attention,
    Error,
    Neutral,
}

/// The one status recipe (Desktop's `.settingsStatus`): an 8px dot in its
/// tone's ink, 6px, then the words, which carry the meaning, at 14/20
/// regular muted. Every status has its dot. Its element is
/// `domain_element_id("settings-state", key)`, named by the words.
pub(crate) fn status_dot(
    key: &str,
    label: impl Into<SharedString>,
    tone: Tone,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let ink = match tone {
        Tone::Success => maka.success,
        Tone::Attention => maka.warning,
        Tone::Error => maka.destructive,
        Tone::Neutral => maka.ink_muted,
    };
    let label = label.into();
    h_flex()
        .id(domain_element_id("settings-state", key))
        .test_support()
        .aria_label(label.clone())
        .flex_shrink_0()
        .items_center()
        .gap_1p5()
        .text_sm()
        .line_height(rems(1.25))
        .font_weight(gpui_kit::FontWeight::NORMAL)
        .text_color(maka.ink_muted)
        .child(div().size_2().flex_shrink_0().rounded_full().bg(ink))
        .child(label)
        .into_any_element()
}

/// An option card of a picker (a theme, a palette, an app icon), as
/// Desktop's Astryx `SelectableCard`: a 1px ring (the accent on the chosen
/// card, the border on the others) that stays whatever the pointer does,
/// and on the chosen card a 2px inset accent ring inside it, 3px of accent
/// in all; the inner ring is a shadow, so nothing moves. Under the pointer
/// the card's fill takes the hover wash inside it, so a hovered card stays
/// visibly weaker than the chosen one. Set the card's id, label, `toggled`,
/// `on_click` and content on `button`.
pub(crate) fn selectable_card(button: Button, selected: bool, cx: &App) -> Div {
    let maka = cx.maka();
    let ring = if selected { maka.accent } else { maka.border };
    v_flex()
        .min_w_0()
        .rounded(RADIUS_SURFACE)
        .border_1()
        .border_color(ring)
        .when(selected, |card| {
            // GPUI paints an inset shadow from the outer edge, under the
            // border: 3px of spread is the border's 1px plus the ring's 2px.
            card.shadow(vec![
                BoxShadow::new(px(0.), px(0.), maka.accent).spread_radius(px(3.)).inset(),
            ])
        })
        .child(button.ghost().flex_1().w_full().h_auto().rounded(RADIUS_SURFACE - gpui_kit::px(1.)))
}

/// Desktop's compact `EmptyState` (`isCompact`): the title centred at
/// 14/600 in ink over its description, 12/20 muted, 8 apart, with 16 of
/// padding around. Its element is `domain_element_id("settings-empty", id)`,
/// named by the title.
pub(crate) fn compact_empty_state(
    id: &str,
    title: impl Into<SharedString>,
    description: Option<SharedString>,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let title = title.into();
    v_flex()
        .id(domain_element_id("settings-empty", id))
        .test_support()
        .aria_label(title.clone())
        .w_full()
        .items_center()
        .p_4()
        .gap_2()
        .child(
            div()
                .text_center()
                .text_sm()
                .line_height(rems(1.25))
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .text_color(maka.ink)
                .child(title),
        )
        .children(description.map(|description| {
            div()
                .text_center()
                .text_xs()
                .line_height(rems(1.25))
                .text_color(maka.ink_muted)
                .child(description)
        }))
        .into_any_element()
}

/// Desktop's `EmptyState`: an icon, a title, a line, and an action 16px
/// under them.
pub(crate) fn empty_state(
    id: &str,
    icon: Icon,
    title: impl Into<SharedString>,
    body: Option<SharedString>,
    action: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let title = title.into();
    v_flex()
        .id(domain_element_id("settings-empty", id))
        .test_support()
        .aria_label(title.clone())
        .w_full()
        .items_center()
        .py_8()
        .gap_2()
        .child(icon.size_6().text_color(maka.ink_muted))
        .child(
            div()
                .text_sm()
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(maka.ink)
                .child(title),
        )
        .children(body.map(|body| {
            div().max_w(rems(28.)).text_center().text_xs().text_color(maka.ink_muted).child(body)
        }))
        // 16px under the words (the column's 8px gap and 8 more).
        .children(action.map(|action| div().mt_2().child(action)))
        .into_any_element()
}

/// Why a page of the Host's policy has nothing to show: not connected, or
/// the policy could not be read (with Retry). `None` once it is read, and
/// while the first read is in flight.
pub(crate) fn policy_status(
    key: &'static str,
    host: &Entity<HostSession>,
    policy: &Entity<HostPolicy>,
    cx: &App,
) -> Option<StatusLine> {
    if !host.read(cx).is_connected() {
        return Some(StatusLine::info(key, copy::PERMISSIONS_OFFLINE.get(cx)));
    }
    let read = policy.read(cx);
    let message = read.load_error().filter(|_| read.policy().is_none())?.clone();
    let reason = failure(Locale::current(cx), copy::GENERAL_LOAD_FAILED.get(cx), &message);
    let policy = policy.clone();
    let retry = settings_button(domain_element_id("settings-retry", key), copy::RETRY.get(cx), cx)
        .on_click(move |_, _, cx| policy.update(cx, |policy, cx| policy.reload(cx)));
    Some(StatusLine::error(key, reason).action(retry))
}

/// How long ago `timestamp_ms` was, as a turn footer words it, in the
/// zone `utc_offset` seconds east of UTC (the page reads it once, never in
/// render).
pub(crate) fn ago(locale: Locale, timestamp_ms: u64, utc_offset: i32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64);
    shared::time::relative_time(locale, timestamp_ms, now, utc_offset)
}

/// A warning among a group's rows (Desktop's warning `Banner`): the
/// warning glyph and the sentence in the warning ink, so it reads without
/// the colour. Its element is `domain_element_id("settings-warning", key)`.
pub(crate) fn warning_line(key: &str, message: impl Into<SharedString>, cx: &App) -> AnyElement {
    let ink = cx.maka().warning;
    let message = message.into();
    h_flex()
        .id(domain_element_id("settings-warning", key))
        .test_support()
        .aria_label(message.clone())
        .w_full()
        .items_start()
        .gap_1p5()
        .py_2()
        .text_xs()
        .text_color(ink)
        .child(
            h_flex().h(rems(1.25)).child(
                Icon::new(gpui_kit::assets::IconName::TriangleAlert).size_3().text_color(ink),
            ),
        )
        .child(div().flex_1().min_w_0().line_height(rems(1.25)).child(message))
        .into_any_element()
}

/// What an action found as one line: Desktop's toast title, then its
/// detail as a sentence of its own ("Tavily key saved. Select Test
/// credentials to verify it with a real request."). A detail that is a
/// clause (a Host error's) is capitalized and closed. Desktop's titles
/// carry no full stop, which [`shared::copy::failure`] expects of its
/// first part.
pub(crate) fn titled(locale: Locale, title: &str, detail: &str) -> String {
    let detail = detail.trim();
    let mut chars = detail.chars();
    let Some(first) = chars.next() else {
        return title.to_owned();
    };
    let end = match detail.chars().last() {
        Some('.' | '!' | '?' | '。' | '！' | '？' | '…') => "",
        _ if locale.is_cjk() && detail.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)) => {
            "。"
        }
        _ => ".",
    };
    let detail = format!("{}{}{end}", first.to_uppercase(), chars.as_str());
    shared::copy::phrases(locale, title, &detail)
}
