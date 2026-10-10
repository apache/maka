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

//! Quotes on a message (`QuoteRef`): the chips a user row shows for the
//! quotes it carries, and the side chat's staged ones above its composer.
//! After Maka Desktop's `QuoteRefChip` (packages/ui/src/quote-ref-chip.tsx):
//! one line, the label first, the excerpt clipped; a chip on a sent message
//! opens to the whole excerpt and the note.

use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_kit::component::{Icon, Selectable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, WeakEntity, Window, div, prelude::FluentBuilder as _,
};
use shared::copy::conversation as copy;
use shared::copy::{self as shell_copy, Locale};
use shared::icons::MakaIcon;
use shared::theme::ActiveMakaPalette as _;

use crate::rows::SentQuote;
use crate::style::{LABEL_SIZE, RADIUS_CONTROL, RADIUS_SURFACE, SUPPORTING_SIZE, dp, dp_px};
use crate::view::ConversationView;

/// What a quote's chip reads aloud: its label and excerpt, then its note.
pub(crate) fn spoken(
    locale: Locale,
    label: Option<&str>,
    text: &str,
    comment: Option<&str>,
) -> SharedString {
    let quoted = match label {
        Some(label) => shell_copy::labeled(locale, label, text),
        None => text.to_owned(),
    };
    let mut parts = vec![copy::QUOTE.in_locale(locale).to_owned(), quoted];
    if let Some(comment) = comment {
        parts.push(comment.to_owned());
    }
    shell_copy::parts(locale, &parts.iter().map(String::as_str).collect::<Vec<_>>()).into()
}

/// A chip's words: a rule on its leading edge (a block quote's), the label
/// in ink at 500, then the excerpt in muted ink; on one line unless
/// `expanded`, when the excerpt wraps whole and the note follows in ink.
fn content(
    label: Option<&SharedString>,
    text: &SharedString,
    comment: Option<&SharedString>,
    expanded: bool,
    cx: &App,
) -> impl IntoElement {
    let maka = cx.maka();
    let label = label.map(|label| {
        div().flex_none().font_weight(FontWeight::MEDIUM).text_color(maka.ink).child(label.clone())
    });
    let excerpt = div().min_w_0().text_color(maka.ink_muted).child(text.clone());
    let words = if expanded {
        v_flex().min_w_0().flex_1().gap(dp(2.)).children(label).child(excerpt).when_some(
            comment,
            |this, comment| {
                this.child(
                    div()
                        .text_size(dp(SUPPORTING_SIZE))
                        .text_color(maka.ink)
                        .child(comment.clone()),
                )
            },
        )
    } else {
        v_flex().min_w_0().flex_1().child(
            h_flex().min_w_0().gap(dp(4.)).children(label).child(excerpt.flex_1().truncate()),
        )
    };
    // The rule spans the first line's 16 px of ink, on its 20 px line.
    let rule = div().flex_none().w(dp(2.)).h(dp(16.)).mt(dp(2.)).rounded_full();
    h_flex()
        .items_start()
        .min_w_0()
        .gap(dp(8.))
        .text_size(dp(LABEL_SIZE))
        .line_height(dp(20.))
        .child(rule.bg(maka.border_strong))
        .child(words)
}

/// A quote on a sent message: a quiet button on the sunken fill that opens
/// to the whole excerpt and its note and closes again (Desktop's chip
/// expands when its text is clipped; here it always may, so the keyboard
/// reaches the whole text the same way).
pub(crate) fn sent_quote_chip(
    quote: &SentQuote,
    view: WeakEntity<ConversationView>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let locale = Locale::current(cx);
    let spoken = spoken(locale, quote.label.as_deref(), &quote.text, quote.comment.as_deref());
    let key = quote.key.clone();
    Button::new(shared::domain_element_id("sent-quote", &quote.key))
        .custom(
            ButtonCustomVariant::new(cx)
                .color(maka.sunken)
                .foreground(maka.ink)
                .hover(maka.sunken)
                .active(maka.sunken)
                .shadow(false),
        )
        .h_auto()
        .min_h(dp(28.))
        .max_w_full()
        .min_w_0()
        .px(dp(10.))
        .py(dp(5.))
        .rounded(dp_px(RADIUS_SURFACE, window))
        .accessibility_label(spoken)
        .selected(quote.expanded)
        .child(content(
            quote.label.as_ref(),
            &quote.text,
            quote.comment.as_ref(),
            quote.expanded,
            cx,
        ))
        .on_click(move |_, _, cx| {
            view.update(cx, |view, cx| view.toggle_quote(&key, cx)).ok();
        })
        .into_any_element()
}

/// A quote staged for the next message, above the composer's draft: the
/// chip on the sunken fill with a remove button at its end.
pub(crate) fn staged_quote_chip(
    id: ElementId,
    label: Option<&SharedString>,
    text: &SharedString,
    remove: impl Fn(&mut Window, &mut App) + 'static,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let locale = Locale::current(cx);
    let spoken = spoken(locale, label.map(|label| label.as_str()), text, None);
    let remove_label = copy::remove_quote(locale, text);
    h_flex()
        .id(id)
        .test_support()
        .aria_label(spoken)
        .max_w_full()
        .min_w_0()
        .h(dp(28.))
        .pl(dp(10.))
        .pr(dp(4.))
        .gap(dp(6.))
        .rounded(dp(RADIUS_SURFACE))
        .bg(maka.sunken)
        .child(div().min_w_0().flex_1().child(content(label, text, None, false, cx)))
        .child(
            Button::new("quote-remove")
                .ghost()
                .size(dp(20.))
                .p_0()
                .flex_none()
                .rounded(dp_px(RADIUS_CONTROL, window))
                .child(
                    Icon::new(MakaIcon::Close)
                        .with_size(dp_px(12., window))
                        .text_color(maka.ink_muted),
                )
                .accessibility_label(remove_label.clone())
                .tooltip(remove_label)
                .on_click(move |_, window, cx| remove(window, cx)),
        )
        .into_any_element()
}
