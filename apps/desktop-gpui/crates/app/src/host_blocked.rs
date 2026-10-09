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

//! The plate while no connection attempt can succeed until a person acts
//! outside the app ([`HostBlocker`]): a Runtime Host of another protocol
//! epoch refused this client, or there is no built Maka checkout to start
//! one from. It takes the place of the task view (or the page) under the
//! header, where the disconnected strip would otherwise say the same thing
//! as one error sentence: which side is newer, both epochs, the commit this
//! client was built for (`MAKA_PIN`), the checkout, the commands that fix
//! it, then Retry and Switch data folder….
//!
//! Both buttons dispatch the window's Actions ([`Reconnect`], also ⌘R, and
//! [`SwitchStateRoot`]), so they reach the same owners as the menus; they
//! and the copy button are ordinary Tab stops.

use std::path::{Path, PathBuf};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::clipboard::Clipboard;
use gpui_kit::component::{ActiveTheme as _, StyledExt as _, h_flex, v_flex};
use gpui_kit::{
    Action as _, AnyElement, App, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, Role, SharedString, StatefulInteractiveElement as _, Styled as _,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, px, rems,
};
use host_protocol::{MAKA_PIN_COMMIT, ReplacementDisposition};
use shared::copy::host as copy;
use shared::copy::{self as shell_copy, Locale};
use shared::layout::COLUMN_MAX_WIDTH_REMS;
use shared::theme::{
    ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS, RADIUS_SURFACE, control_button,
    quiet_button,
};
use workspace::HostBlocker;
use workspace::actions::{Reconnect, SwitchStateRoot};

/// Width of the fact labels ("This client", "Built for"): the longest
/// Chinese label on one line.
const FACT_LABEL_WIDTH_REMS: f32 = 8.;

/// What the screen explains and what it can offer.
#[derive(IntoElement)]
pub(crate) struct HostBlockedScreen {
    blocker: HostBlocker,
    /// The checkout Hosts start from, for an epoch mismatch; a missing
    /// checkout names its own.
    checkout: Option<PathBuf>,
    /// A retry the user asked for is running.
    retrying: bool,
}

impl HostBlockedScreen {
    pub(crate) fn new(blocker: HostBlocker, checkout: Option<PathBuf>, retrying: bool) -> Self {
        Self { blocker, checkout, retrying }
    }
}

/// The parts of one screen, in reading order.
struct Content {
    title: &'static str,
    summary: &'static str,
    facts: Vec<Fact>,
    steps: String,
    commands: Option<String>,
    note: Option<&'static str>,
}

/// A label and its value; `mono` for machine text (a commit, a path),
/// which never holds Chinese, so no glyph falls back inside a mono run; the
/// words about it go in `detail`, a muted line under it.
struct Fact {
    id: &'static str,
    label: &'static str,
    value: String,
    mono: bool,
    detail: Option<&'static str>,
}

impl Fact {
    fn new(id: &'static str, label: &'static str, value: String) -> Self {
        Self { id, label, value, mono: false, detail: None }
    }

    fn mono(mut self) -> Self {
        self.mono = true;
        self
    }
}

/// The commit this client was built for, and where it is recorded.
fn pin_fact(locale: Locale) -> Fact {
    let fact =
        Fact::new("host-blocked-pin", copy::PIN_LABEL.in_locale(locale), MAKA_PIN_COMMIT.into())
            .mono();
    Fact { detail: Some(copy::PIN_DETAIL.in_locale(locale)), ..fact }
}

fn checkout_fact(locale: Locale, path: &Path, detail: Option<&'static str>) -> Fact {
    let fact = Fact::new(
        "host-blocked-checkout",
        copy::CHECKOUT_LABEL.in_locale(locale),
        path.display().to_string(),
    )
    .mono();
    Fact { detail, ..fact }
}

impl HostBlockedScreen {
    fn content(&self, locale: Locale) -> Content {
        let text = |key: shell_copy::Text| key.in_locale(locale);
        match &self.blocker {
            HostBlocker::Epoch(mismatch) => {
                let mut facts = vec![
                    Fact::new(
                        "host-blocked-client-epoch",
                        text(copy::CLIENT_LABEL),
                        copy::epoch_value(locale, mismatch.client),
                    ),
                    Fact::new(
                        "host-blocked-host-epoch",
                        text(copy::HOST_LABEL),
                        copy::epoch_value(locale, mismatch.host),
                    ),
                    pin_fact(locale),
                ];
                facts
                    .extend(self.checkout.as_deref().map(|path| checkout_fact(locale, path, None)));
                let newer = mismatch.host_is_newer();
                Content {
                    title: text(if newer {
                        copy::HOST_NEWER_TITLE
                    } else {
                        copy::HOST_OLDER_TITLE
                    }),
                    summary: text(copy::EPOCH_SUMMARY),
                    facts,
                    steps: if newer {
                        copy::update_client_steps(locale, mismatch.host)
                    } else {
                        text(copy::UPDATE_HOST_STEPS).to_owned()
                    },
                    commands: self
                        .checkout
                        .as_deref()
                        .map(|path| copy::pin_commands(path, MAKA_PIN_COMMIT)),
                    note: match &mismatch.replacement {
                        Some(ReplacementDisposition::WaitForIdleExit) => {
                            Some(text(copy::HOST_EXITS_WHEN_IDLE))
                        }
                        Some(ReplacementDisposition::BlockedByResidency) => {
                            Some(text(copy::HOST_KEEPS_RUNNING))
                        }
                        _ => None,
                    },
                }
            }
            HostBlocker::Checkout(checkout) => {
                let origin = if checkout.from_environment {
                    copy::CHECKOUT_FROM_ENVIRONMENT
                } else {
                    copy::CHECKOUT_DEFAULT
                };
                Content {
                    title: text(if checkout.exists {
                        copy::CHECKOUT_UNBUILT_TITLE
                    } else {
                        copy::CHECKOUT_MISSING_TITLE
                    }),
                    summary: text(copy::CHECKOUT_SUMMARY),
                    facts: vec![
                        checkout_fact(locale, &checkout.path, Some(text(origin))),
                        pin_fact(locale),
                    ],
                    steps: copy::checkout_steps(locale, &checkout.path, checkout.exists),
                    commands: Some(if checkout.exists {
                        copy::build_commands(&checkout.path)
                    } else {
                        copy::clone_commands(&checkout.path, MAKA_PIN_COMMIT)
                    }),
                    note: None,
                }
            }
            _ => Content {
                title: text(shell_copy::DISCONNECTED_TITLE),
                summary: text(shell_copy::DISCONNECTED_SUSPENDED),
                facts: Vec::new(),
                steps: String::new(),
                commands: None,
                note: None,
            },
        }
    }
}

impl RenderOnce for HostBlockedScreen {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let maka = cx.maka();
        let content = self.content(Locale::current(cx));
        let title: SharedString = content.title.into();
        let retry = shell_copy::RETRY.get(cx);
        let switch = shell_copy::SWITCH_STATE_ROOT.get(cx);
        // The column scrolls when a short window cannot hold it, and sits
        // in the middle of the plate otherwise (the auto margins).
        v_flex()
            .id("host-blocked")
            .test_support()
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .px_6()
            .child(
                v_flex()
                    .w_full()
                    .max_w(rems(COLUMN_MAX_WIDTH_REMS))
                    .mx_auto()
                    .my_auto()
                    .py_8()
                    .gap_4()
                    .child(
                        v_flex()
                            .gap_1()
                            .child(
                                div()
                                    .id("host-blocked-title")
                                    .test_support()
                                    .role(Role::Heading)
                                    .aria_label(title.clone())
                                    .text_size(rems(HEADING_TEXT_REMS))
                                    .line_height(rems(HEADING_LINE_REMS))
                                    .font_semibold()
                                    .text_color(maka.ink)
                                    .child(title),
                            )
                            .child(
                                div()
                                    .id("host-blocked-summary")
                                    .test_support()
                                    .aria_label(content.summary)
                                    .text_sm()
                                    .text_color(maka.ink_muted)
                                    .child(content.summary),
                            ),
                    )
                    .when(!content.facts.is_empty(), |this| {
                        this.child(
                            v_flex()
                                .gap_1()
                                .children(content.facts.into_iter().map(|fact| fact_row(fact, cx))),
                        )
                    })
                    .when(!content.steps.is_empty(), |this| {
                        this.child(
                            div()
                                .id("host-blocked-steps")
                                .test_support()
                                .aria_label(content.steps.clone())
                                .text_sm()
                                .text_color(maka.ink)
                                .child(content.steps),
                        )
                    })
                    .children(content.commands.map(|commands| commands_block(commands, cx)))
                    .children(content.note.map(|note| {
                        div()
                            .id("host-blocked-note")
                            .test_support()
                            .aria_label(note)
                            .text_sm()
                            .text_color(maka.ink_muted)
                            .child(note)
                    }))
                    .child(
                        h_flex()
                            .gap_2()
                            .pt_2()
                            .child(
                                quiet_button(Button::new("host-blocked-retry"), cx)
                                    .label(retry)
                                    .loading(self.retrying)
                                    .tooltip_with_action(retry, &Reconnect, None)
                                    .on_click(|_, window, cx| {
                                        window.dispatch_action(Reconnect.boxed_clone(), cx);
                                    }),
                            )
                            .child(
                                control_button(
                                    Button::new("host-blocked-switch-data-folder").ghost(),
                                )
                                .label(switch)
                                .on_click(|_, window, cx| {
                                    window.dispatch_action(SwitchStateRoot.boxed_clone(), cx);
                                }),
                            ),
                    ),
            )
    }
}

/// One fact: the label in a fixed lane, the value beside it (machine text
/// in the mono face), and an optional muted line under the value. The
/// value is named "label: value", so it reads as a pair.
fn fact_row(fact: Fact, cx: &App) -> AnyElement {
    let maka = cx.maka();
    let value = div()
        .id(fact.id)
        .test_support()
        .aria_label(shell_copy::labeled(Locale::current(cx), fact.label, &fact.value))
        .min_w_0()
        .text_color(maka.ink)
        .when(fact.mono, |this| this.font_family(cx.theme().mono_font_family.clone()))
        .child(fact.value);
    h_flex()
        .items_start()
        .gap_3()
        .text_sm()
        .child(
            div()
                .w(rems(FACT_LABEL_WIDTH_REMS))
                .flex_shrink_0()
                .text_color(maka.ink_muted)
                .child(fact.label),
        )
        .child(v_flex().flex_1().min_w_0().child(value).children(
            fact.detail.map(|detail| div().text_xs().text_color(maka.ink_muted).child(detail)),
        ))
        .into_any_element()
}

/// The commands on the code tone, compact mono 12/20, one per line, with a
/// button that copies them all.
fn commands_block(commands: String, cx: &App) -> AnyElement {
    let maka = cx.maka();
    h_flex()
        .items_start()
        .gap_2()
        .rounded(RADIUS_SURFACE)
        .bg(maka.code)
        .pl_3()
        .pr_1()
        .py(px(10.))
        .child(
            div()
                .id("host-blocked-commands")
                .test_support()
                .aria_label(commands.clone())
                .flex_1()
                .min_w_0()
                .font_family(cx.theme().mono_font_family.clone())
                .text_xs()
                .line_height(px(20.))
                .text_color(maka.ink)
                .child(commands.clone()),
        )
        .child(
            Clipboard::new("copy-host-blocked-commands")
                .value(commands)
                .tooltip(copy::COPY_COMMANDS.get(cx)),
        )
        .into_any_element()
}
