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

//! The workbar's Trace face, Desktop's `SessionInspectorPanel`
//! (`session-inspector-panel.tsx`, `styles/workbar/inspector.css`), in this
//! client's design language: read top to bottom, the overview first (where
//! the task stands: its tokens, its time, its cost, how full its context
//! window is and what filled it), the timeline under it (what happened,
//! Turn by Turn, newest first, each opening to its steps).
//!
//! Read-only. Every judgement is in [`crate::model`]; this lays it out. The
//! bars are the legends' pictures, never their only copy: each band is a
//! labelled row with its figure, so no fact rests on colour. Desktop draws
//! the token and time splits as rings; here they are bars like the context
//! window's, one shape for every split.
//!
//! The face is one scroll region. The timeline holds the pages the person
//! asked for (16 Turns each, folded to one line until opened), as
//! Desktop's does, so it is drawn whole rather than virtualized.

use std::collections::HashSet;

use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, IconName, Sizable as _, StyledExt as _,
    WindowExt as _, h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClipboardItem, Context, Div, Entity, EventEmitter,
    FocusHandle, Hsla, InteractiveElement as _, IntoElement, ParentElement as _, Render, Role,
    ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription,
    TestSupportExt as _, Window, div, prelude::FluentBuilder as _, relative, rems,
};
use host_protocol::{ContextSegmentKind, ModelCallKind, ToolRecoveryDisposition};
use shared::copy::{self as shell_copy, Locale, Text, inspector as copy};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, MakaPalette, quiet_button, tabular_nums};
use shared::time::{local_utc_offset, short_date_time};
use workspace::HostSession;

use crate::model::{
    CompositionState, ContextBand, ContextBudget, ContextLevel, CoverageKind, CoverageNotice,
    DurationKind, OverviewModel, PanelModel, StepKind, StepRow, TokenKind, TurnRow, compact_tokens,
    format_cost, format_duration, format_percent, group_digits, overview_model, panel_model,
};
use crate::read::ReadFailure;
use crate::state::InspectorState;
use crate::{Back, INSPECTOR_CONTEXT};

/// A Turn's chevron, and the gap after it: its steps start under its label.
const CHEVRON_REMS: f32 = 0.875;
const CHEVRON_GAP_REMS: f32 = 0.5;
/// How far a row's fill reaches past the content's edge, so its text sits
/// on the edge (the plate's 16 px line) while its fill starts 8 px in.
const ROW_BLEED_REMS: f32 = 0.5;
/// Supporting text: 12 px on 20 px lines.
const SUPPORTING_LINE_REMS: f32 = 1.25;

/// Emitted by [`InspectorView`].
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum InspectorViewEvent {
    /// Escape in the face: the panel gives the conversation its place.
    Dismiss,
}

/// The Trace face.
///
/// Behavior owner for which Turns are open and the copy of a pricing key;
/// [`InspectorState`] owns the reads and their freshness. What is drawn is
/// derived when the state changes, never in `render`.
pub struct InspectorView {
    state: Entity<InspectorState>,
    focus: FocusHandle,
    scroll: ScrollHandle,
    /// The Turns shown open, by key.
    open: HashSet<String>,
    /// Whether the task's newest Turn was opened when its trace arrived.
    seeded: bool,
    /// The task the open set belongs to.
    session: Option<SharedString>,
    /// The state's version the models below were derived at.
    derived: Option<u64>,
    panel: PanelModel,
    overview: OverviewModel,
    /// The local zone's offset, read when the trace changes.
    utc_offset: i32,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<InspectorViewEvent> for InspectorView {}

impl std::fmt::Debug for InspectorView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InspectorView")
            .field("session", &self.session)
            .field("open", &self.open.len())
            .finish_non_exhaustive()
    }
}

impl InspectorView {
    pub fn new(host: Entity<HostSession>, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = cx.new(|cx| InspectorState::new(host, cx));
        let subscriptions = vec![cx.observe(&state, |this, _, cx| this.sync(cx))];
        let mut view = Self {
            state,
            focus: cx.focus_handle(),
            scroll: ScrollHandle::new(),
            open: HashSet::new(),
            seeded: false,
            session: None,
            derived: None,
            panel: PanelModel::default(),
            overview: OverviewModel::default(),
            utc_offset: local_utc_offset(),
            _subscriptions: subscriptions,
        };
        view.sync(cx);
        view
    }

    /// What the face reads and keeps fresh.
    pub fn state(&self) -> &Entity<InspectorState> {
        &self.state
    }

    /// Follows task `session_id`.
    pub fn set_session(&mut self, session_id: Option<SharedString>, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_session(session_id, cx));
    }

    /// Whether the face shows: it reads and refreshes only while it does.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.set_shown(shown, cx));
    }

    /// Follows task `session_id` and whether the face shows, together
    /// ([`InspectorState::follow`]).
    pub fn follow(
        &mut self,
        session_id: Option<SharedString>,
        shown: bool,
        cx: &mut Context<Self>,
    ) {
        self.state.update(cx, |state, cx| state.follow(session_id, shown, cx));
    }

    pub fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    /// The Turns shown open, by key ([`TurnRow::key`]).
    pub fn open_turns(&self) -> &HashSet<String> {
        &self.open
    }

    /// The timeline as drawn.
    pub fn panel(&self) -> &PanelModel {
        &self.panel
    }

    /// The overview as drawn.
    pub fn overview(&self) -> &OverviewModel {
        &self.overview
    }

    /// Opens or folds the Turn `key`.
    pub fn toggle_turn(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self.open.remove(key) {
            self.open.insert(key.to_owned());
        }
        cx.notify();
    }

    /// Re-derives what is drawn when the state moved on. Another task
    /// starts with nothing open; the first trace of a task opens its newest
    /// Turn.
    fn sync(&mut self, cx: &mut Context<Self>) {
        let state = self.state.read(cx);
        if self.derived == Some(state.version()) {
            return;
        }
        if state.session_id() != self.session.as_ref() {
            self.session = state.session_id().cloned();
            self.open.clear();
            self.seeded = false;
        }
        self.derived = Some(state.version());
        self.panel = panel_model(state.trace().map(|trace| trace.as_ref()));
        self.overview = overview_model(state.context(), state.usage());
        self.utc_offset = local_utc_offset();
        if !self.seeded && state.trace().is_some() {
            self.seeded = true;
            if let Some(newest) = self.panel.turns.first() {
                self.open.insert(newest.key());
            }
        }
        cx.notify();
    }

    fn back(&mut self, _: &Back, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InspectorViewEvent::Dismiss);
    }

    fn copy_pricing_key(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(key.to_owned()));
        let toast = Notification::success(key.to_owned()).title(copy::PRICING_KEY_COPIED.get(cx));
        window.push_notification(toast, cx);
    }

    // The whole face's states.

    fn render_failure(&self, failure: &ReadFailure, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let text = shell_copy::failure(locale, copy::LOAD_FAILED.get(cx), &why(failure, locale));
        shared::rows::StatusLine::error("inspector-failure", text)
            .action(
                quiet_button(Button::new("inspector-retry"), cx)
                    .small()
                    .label(copy::RETRY.get(cx))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.state.update(cx, |state, cx| state.retry(cx));
                    })),
            )
            .into_any_element()
    }

    fn render_empty(&self, cx: &App) -> AnyElement {
        let maka = cx.maka();
        let title = copy::EMPTY.get(cx);
        let help = copy::EMPTY_HELP.get(cx);
        v_flex()
            .id("inspector-empty")
            .test_support()
            .aria_label(shell_copy::phrases(Locale::current(cx), title, help))
            .w_full()
            .items_center()
            .py_8()
            .gap_2()
            .child(Icon::new(MakaIcon::Activity).size_6().text_color(maka.ink_muted))
            .child(div().text_sm().font_medium().text_center().text_color(maka.ink).child(title))
            .child(supporting(help, maka.ink_muted).text_center())
            .into_any_element()
    }

    // The overview.

    fn render_overview(&self, cx: &App) -> Vec<AnyElement> {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let state = self.state.read(cx);
        let overview = &self.overview;
        let mut blocks = Vec::new();

        if let Some(tokens) = &overview.token_usage {
            let total = tokens.total as f64;
            let readout = tokens.dominant().map(|(kind, amount)| {
                shell_copy::labeled(
                    locale,
                    token_label(kind).in_locale(locale),
                    &format_percent(amount as f64 / total),
                )
            });
            let rows = tokens.segments.iter().map(|(kind, amount)| {
                fact_row(
                    ("tokens", token_key(*kind)),
                    Some(swatch(token_fill(*kind, &maka))),
                    token_label(*kind).in_locale(locale),
                    &format!(
                        "{} · {}",
                        compact_tokens(*amount),
                        format_percent(*amount as f64 / total)
                    ),
                    cx,
                )
            });
            let bands: Vec<(f64, Hsla)> = tokens
                .segments
                .iter()
                .map(|(kind, amount)| (*amount as f64, token_fill(*kind, &maka)))
                .collect();
            blocks.push(
                v_flex()
                    .id("inspector-tokens")
                    .test_support()
                    .w_full()
                    .gap_2()
                    .child(section_head(
                        "tokens",
                        copy::TOKEN_USAGE.get(cx),
                        readout,
                        maka.ink_muted,
                        cx,
                    ))
                    .child(bar("tokens", &bands, &maka))
                    .child(v_flex().gap_1().children(rows))
                    .into_any_element(),
            );
        }

        if let Some(time) = &overview.duration_usage {
            let total = time.total_duration_ms;
            let readout =
                shell_copy::labeled(locale, copy::RECORDED_TIME.get(cx), &format_duration(total));
            let rows = time.segments.iter().map(|segment| {
                let (key, label) = match segment.kind {
                    DurationKind::Model => ("model", copy::model_calls(locale, segment.count)),
                    DurationKind::Tool => ("tool", copy::tool_runs(locale, segment.count)),
                };
                let share = if total > 0. { segment.duration_ms / total } else { 0. };
                fact_row(
                    ("time", key),
                    Some(swatch(duration_fill(segment.kind, &maka))),
                    &label,
                    &format!(
                        "{} · {}",
                        format_duration(segment.duration_ms),
                        format_percent(share)
                    ),
                    cx,
                )
            });
            let bands: Vec<(f64, Hsla)> = time
                .segments
                .iter()
                .map(|segment| (segment.duration_ms, duration_fill(segment.kind, &maka)))
                .collect();
            blocks.push(
                v_flex()
                    .id("inspector-time")
                    .test_support()
                    .w_full()
                    .gap_2()
                    .child(section_head(
                        "time",
                        copy::TIME_BREAKDOWN.get(cx),
                        Some(readout),
                        maka.ink_muted,
                        cx,
                    ))
                    .when(total > 0., |this| this.child(bar("time", &bands, &maka)))
                    .child(v_flex().gap_1().children(rows))
                    .into_any_element(),
            );
        }

        if let Some(usage) = state.usage().filter(|usage| usage.summary.total_requests > 0) {
            let cost = format_cost(usage.estimated_cost())
                .unwrap_or_else(|| copy::COST_UNKNOWN.get(cx).to_owned());
            blocks.push(
                v_flex()
                    .id("inspector-cost")
                    .test_support()
                    .w_full()
                    .gap_2()
                    .child(section_head(
                        "cost",
                        copy::ESTIMATED_COST.get(cx),
                        Some(cost),
                        maka.ink_muted,
                        cx,
                    ))
                    .when_some(overview.cache_hit_rate, |this, rate| {
                        this.child(section_head(
                            "cache-hit",
                            copy::CACHE_HIT_RATE.get(cx),
                            Some(format_percent(rate)),
                            maka.ink_muted,
                            cx,
                        ))
                    })
                    .child(supporting(copy::COST_HELP.get(cx), maka.ink_muted))
                    .into_any_element(),
            );
        }

        if let Some(context) = &overview.context {
            blocks.push(self.render_context(context, cx));
        }

        if let Some(composition) = &overview.composition {
            blocks.push(render_composition(composition, cx));
        }
        blocks
    }

    fn render_context(&self, context: &ContextBudget, cx: &App) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let level = context.level();
        let fill = match level {
            ContextLevel::Normal => maka.accent,
            ContextLevel::Warning => maka.warning,
            ContextLevel::Error => maka.destructive,
        };
        let readout_ink = match level {
            ContextLevel::Normal => maka.ink_muted,
            ContextLevel::Warning => maka.warning,
            ContextLevel::Error => maka.destructive,
        };
        let readout = format!(
            "{} / {} · {}",
            compact_tokens(context.used_tokens),
            compact_tokens(context.window_tokens),
            format_percent(context.ratio)
        );
        let band_fill = |band: ContextBand| match band {
            ContextBand::CacheRead => fill.opacity(0.55),
            ContextBand::Fresh | ContextBand::Used => fill,
            ContextBand::Free => Hsla::transparent_black(),
        };
        let bands: Vec<(f64, Hsla)> = context
            .segments
            .iter()
            .map(|(band, tokens)| (*tokens as f64, band_fill(*band)))
            .collect();
        let rows = context.segments.iter().map(|(band, tokens)| {
            let (key, label) = match band {
                ContextBand::CacheRead => ("cache-hit", copy::SEGMENT_CACHE_HIT),
                ContextBand::Fresh => ("cache-miss", copy::SEGMENT_CACHE_MISS),
                ContextBand::Used => ("used", copy::SEGMENT_USED),
                ContextBand::Free => ("free", copy::SEGMENT_FREE),
            };
            // Headroom is the absence of the rest: a ring, not a third
            // solid category.
            let mark =
                if *band == ContextBand::Free { ring(&maka) } else { swatch(band_fill(*band)) };
            fact_row(
                ("context", key),
                Some(mark),
                label.in_locale(locale),
                &group_digits(*tokens),
                cx,
            )
        });
        v_flex()
            .id("inspector-context")
            .test_support()
            .w_full()
            .gap_2()
            .child(section_head(
                "context",
                copy::CONTEXT_WINDOW.get(cx),
                Some(readout),
                readout_ink,
                cx,
            ))
            .child(bar("context", &bands, &maka))
            .child(v_flex().gap_1().children(rows))
            .into_any_element()
    }

    // The timeline.

    fn render_timeline(&self, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let state = self.state.read(cx);
        let next_cursor = state.next_cursor().is_some();
        let can_hide = state.can_hide_earlier();
        let busy = state.is_trace_loading() || state.is_earlier_loading();
        let earlier_loading = state.is_earlier_loading();
        let pager = (next_cursor || can_hide).then(|| {
            let label = if can_hide {
                copy::HIDE_EARLIER
            } else if earlier_loading {
                copy::LOADING_EARLIER
            } else {
                copy::LOAD_EARLIER
            };
            Button::new("inspector-load-earlier")
                .ghost()
                .small()
                .ml(rems(-ROW_BLEED_REMS))
                .label(label.get(cx))
                .disabled(busy)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.state.update(cx, |state, cx| {
                        if can_hide {
                            state.hide_earlier(cx);
                        } else {
                            state.load_earlier(cx);
                        }
                    });
                }))
        });
        let turns: Vec<AnyElement> =
            self.panel.turns.iter().map(|turn| self.render_turn(turn, cx)).collect();
        v_flex()
            .id("inspector-timeline")
            .test_support()
            .w_full()
            .gap_2()
            .child(section_head("timeline", copy::TIMELINE.get(cx), None, maka.ink_muted, cx))
            .when_some(self.panel.coverage, |this, coverage| {
                this.child(render_coverage(coverage, cx))
            })
            .child(v_flex().gap_1().children(turns))
            .children(pager.map(|pager| h_flex().child(pager)))
            .into_any_element()
    }

    fn render_turn(&self, turn: &TurnRow, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let key = turn.key();
        let open = self.open.contains(&key);
        let started = short_date_time(locale, turn.started_at.max(0.) as u64, self.utc_offset);
        let label = copy::turn_label(locale, &started);
        let failure = turn.failed.then(|| failure_label(turn.failure_code.as_deref()).get(cx));
        let cost =
            format_cost(turn.cost_usd).unwrap_or_else(|| copy::COST_UNKNOWN.get(cx).to_owned());
        let meta = format!("{} · {cost}", format_duration(turn.duration_ms));
        let action = if open { copy::HIDE_STEPS } else { copy::SHOW_STEPS }.get(cx);
        let mut spoken = vec![label.as_str()];
        spoken.extend(failure);
        spoken.extend([meta.as_str(), action]);
        let spoken = shell_copy::parts(locale, &spoken);
        let chevron = if open { MakaIcon::ChevronDown } else { MakaIcon::ChevronRight };
        let toggle_key = key.clone();
        let head = Button::new(domain_element_id("inspector-turn-toggle", &key))
            .custom(
                ButtonCustomVariant::new(cx)
                    .color(Hsla::transparent_black())
                    .foreground(maka.ink)
                    .hover(maka.hover)
                    .active(maka.selected)
                    .shadow(false),
            )
            .small()
            .h_7()
            .mx(rems(-ROW_BLEED_REMS))
            .px(rems(ROW_BLEED_REMS))
            .accessibility_label(spoken)
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap(rems(CHEVRON_GAP_REMS))
                    .text_sm()
                    .child(
                        Icon::new(chevron)
                            .size(rems(CHEVRON_REMS))
                            .flex_none()
                            .text_color(maka.ink_muted),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .font_medium()
                            .text_color(maka.ink)
                            .child(label.clone()),
                    )
                    .when_some(failure, |this, failure| {
                        this.child(div().flex_none().text_color(maka.destructive).child(failure))
                    })
                    .child(div().flex_1())
                    .child(
                        div()
                            .flex_none()
                            .font_features(tabular_nums())
                            .text_color(maka.ink_muted)
                            .child(meta),
                    ),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_turn(&toggle_key, cx)));
        let steps: Vec<AnyElement> = if open {
            turn.steps.iter().map(|step| self.render_step(&key, step, cx)).collect()
        } else {
            Vec::new()
        };
        v_flex()
            .id(domain_element_id("inspector-turn", &key))
            .test_support()
            .aria_label(label)
            .child(head)
            .when(open, |this| {
                this.child(
                    v_flex()
                        .id(domain_element_id("inspector-steps", &key))
                        .test_support()
                        .pl(rems(CHEVRON_REMS + CHEVRON_GAP_REMS))
                        .pt_0p5()
                        .pb_1()
                        .gap_1()
                        .children(steps),
                )
            })
            .into_any_element()
    }

    fn render_step(&self, turn_key: &str, step: &StepRow, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let label = match (&step.label, &step.kind) {
            (Some(label), _) => label.clone(),
            (None, kind) => step_kind_label(kind, locale),
        };
        let qualifier: Vec<String> = [
            step.call_kind.as_ref().map(|kind| call_kind_label(kind, locale)),
            step.decision.as_deref().map(|decision| decision_label(decision, locale)),
            step.detail.clone(),
        ]
        .into_iter()
        .flatten()
        .collect();
        let qualifier = (!qualifier.is_empty()).then(|| qualifier.join(" · "));
        let meta: Vec<String> = [
            step.retries.map(|retries| copy::retries(locale, retries)),
            step.duration_ms.map(format_duration),
        ]
        .into_iter()
        .flatten()
        .collect();
        let meta = (!meta.is_empty()).then(|| meta.join(" · "));
        let recovered = step.recovered.as_ref().map(|disposition| {
            let word = match disposition {
                ToolRecoveryDisposition::Completed => copy::RECOVERED_COMPLETED.in_locale(locale),
                ToolRecoveryDisposition::Parked => copy::RECOVERED_PARKED.in_locale(locale),
                other => other.as_str(),
            };
            copy::recovered_as(locale, word)
        });
        let step_key = format!("{turn_key}/{}", step.id);
        let mut spoken: Vec<&str> = vec![&label];
        spoken.extend(qualifier.as_deref());
        spoken.extend(recovered.as_deref());
        spoken.extend(meta.as_deref());
        let spoken = shell_copy::parts(locale, &spoken);
        let pricing = step.unpriced_pricing_key.clone().map(|key| {
            let name = shell_copy::labeled(locale, copy::COPY_PRICING_KEY.get(cx), &key);
            let copied = key.clone();
            h_flex()
                .id(domain_element_id("inspector-pricing-key", &step_key))
                .test_support()
                .aria_label(shell_copy::labeled(locale, copy::UNPRICED_PRICING_KEY.get(cx), &key))
                .flex_wrap()
                .gap_x_1()
                .text_xs()
                .line_height(rems(SUPPORTING_LINE_REMS))
                .text_color(maka.warning)
                .child(copy::UNPRICED_PRICING_KEY.get(cx))
                .child(div().min_w_0().font_family(cx.theme().mono_font_family.clone()).child(key))
                .child(
                    Button::new(domain_element_id("inspector-copy-pricing-key", &step_key))
                        .ghost()
                        .xsmall()
                        .icon(Icon::new(MakaIcon::Copy).size_3().text_color(maka.ink_muted))
                        .accessibility_label(name)
                        .tooltip(copy::COPY_PRICING_KEY.get(cx))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.copy_pricing_key(&copied, window, cx);
                        })),
                )
        });
        h_flex()
            .id(domain_element_id("inspector-step", &step_key))
            .test_support()
            .aria_label(spoken)
            .w_full()
            .items_start()
            .gap_2()
            .text_sm()
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .flex_wrap()
                            .gap_x_2()
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .gap_1()
                                    .when(step.failed, |this| {
                                        this.child(
                                            Icon::new(MakaIcon::StatusFailed)
                                                .size_3()
                                                .flex_none()
                                                .text_color(maka.destructive),
                                        )
                                    })
                                    .child(
                                        div()
                                            .min_w_0()
                                            .text_color(if step.failed {
                                                maka.destructive
                                            } else {
                                                maka.ink
                                            })
                                            .child(label),
                                    ),
                            )
                            .when_some(qualifier, |this, qualifier| {
                                this.child(
                                    div().min_w_0().text_color(maka.ink_muted).child(qualifier),
                                )
                            }),
                    )
                    .children(pricing)
                    .when_some(recovered, |this, recovered| {
                        this.child(supporting(recovered, maka.warning))
                    }),
            )
            .when_some(meta, |this, meta| {
                this.child(
                    div()
                        .flex_none()
                        .font_features(tabular_nums())
                        .text_color(maka.ink_muted)
                        .child(meta),
                )
            })
            .into_any_element()
    }
}

impl Render for InspectorView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        let state = self.state.read(cx);
        let failure = state.trace_failure().cloned();
        let has_trace = state.trace().is_some();
        let trace_loading = state.is_trace_loading();
        let next_cursor = state.next_cursor().is_some();
        let usage_loading = state.is_usage_loading();
        let usage_failed = state.is_usage_failed();
        let usage = state.usage().copied();
        let mut blocks: Vec<AnyElement> = Vec::new();
        if let Some(failure) = &failure {
            blocks.push(self.render_failure(failure, cx));
        }
        // A task that did nothing is not the silence of a read that failed;
        // once read, it stays said through a refresh.
        if self.panel.empty && !next_cursor && failure.is_none() && has_trace {
            blocks.push(self.render_empty(cx));
        }
        if trace_loading && !has_trace {
            blocks.push(line("inspector-loading", copy::LOADING_TRACE.get(cx), &maka));
        }
        // The summary's lines show only while there is none, so a live
        // task's refreshes do not blink them in and out.
        if usage_loading && usage.is_none() {
            blocks.push(line("inspector-usage-loading", copy::LOADING_SUMMARY.get(cx), &maka));
        }
        if (usage_failed && usage.is_none())
            || usage.is_some_and(|usage| usage.has_unavailable_usage())
        {
            blocks.push(line(
                "inspector-usage-unavailable",
                copy::SUMMARY_UNAVAILABLE.get(cx),
                &maka,
            ));
        }
        if usage.is_some() || self.overview.context.is_some() || self.overview.composition.is_some()
        {
            blocks.extend(self.render_overview(cx));
        }
        if !self.panel.empty || next_cursor {
            blocks.push(self.render_timeline(cx));
        }
        v_flex()
            .id("inspector-face")
            .test_support()
            .role(Role::Region)
            .aria_label(copy::REGION.get(cx))
            .track_focus(&self.focus)
            .key_context(INSPECTOR_CONTEXT)
            .on_action(cx.listener(Self::back))
            .relative()
            .size_full()
            .min_w_0()
            .min_h_0()
            .text_color(maka.ink)
            .child(
                v_flex()
                    .id("inspector-body")
                    .test_support()
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .px_4()
                    .py_4()
                    .gap_6()
                    .children(blocks),
            )
            .child(Scrollbar::vertical(&self.scroll))
    }
}

// Pieces.

/// A block's title, with its one figure at the trailing edge (named by its
/// own element, so the figure is read with its title).
fn section_head(
    key: &'static str,
    title: &str,
    readout: Option<String>,
    readout_ink: Hsla,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    h_flex()
        .w_full()
        .gap_2()
        .text_sm()
        .child(
            div().flex_1().min_w_0().font_semibold().text_color(maka.ink).child(title.to_owned()),
        )
        .when_some(readout, |this, readout| {
            this.child(
                div()
                    .id(domain_element_id("inspector-readout", key))
                    .test_support()
                    .aria_label(readout.clone())
                    .flex_none()
                    .font_features(tabular_nums())
                    .text_color(readout_ink)
                    .child(readout),
            )
        })
        .into_any_element()
}

/// A split drawn as one track: each band its share of the whole, a sliver
/// never narrower than 2 px, the track showing what is left.
fn bar(key: &'static str, bands: &[(f64, Hsla)], maka: &MakaPalette) -> AnyElement {
    let total: f64 = bands.iter().map(|(amount, _)| amount).sum();
    h_flex()
        .id(domain_element_id("inspector-bar", key))
        .test_support()
        .w_full()
        .h_1p5()
        .flex_none()
        .rounded_full()
        .overflow_hidden()
        .bg(maka.wash)
        .children(bands.iter().filter(|(amount, _)| *amount > 0. && total > 0.).map(
            |(amount, fill)| {
                div()
                    .h_full()
                    .flex_none()
                    .w(relative((*amount / total) as f32))
                    .min_w_0p5()
                    .bg(*fill)
            },
        ))
        .into_any_element()
}

/// A legend row: the band's mark and name at the leading edge, its figure
/// at the trailing edge.
fn fact_row(
    (group, key): (&'static str, &'static str),
    mark: Option<AnyElement>,
    label: &str,
    value: &str,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    h_flex()
        .id(domain_element_id("inspector-fact", &format!("{group}/{key}")))
        .test_support()
        .aria_label(shell_copy::labeled(Locale::current(cx), label, value))
        .w_full()
        .gap_3()
        .text_sm()
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .gap_2()
                .text_color(maka.ink_muted)
                .children(mark)
                .child(div().min_w_0().truncate().child(label.to_owned())),
        )
        .child(
            div()
                .flex_none()
                .font_features(tabular_nums())
                .text_color(maka.ink)
                .child(value.to_owned()),
        )
        .into_any_element()
}

fn swatch(fill: Hsla) -> AnyElement {
    div().size_1p5().flex_none().rounded_full().bg(fill).into_any_element()
}

fn ring(maka: &MakaPalette) -> AnyElement {
    div()
        .size_1p5()
        .flex_none()
        .rounded_full()
        .border_1()
        .border_color(maka.border_strong)
        .into_any_element()
}

fn supporting(text: impl Into<SharedString>, ink: Hsla) -> Div {
    div().text_xs().line_height(rems(SUPPORTING_LINE_REMS)).text_color(ink).child(text.into())
}

fn line(id: &'static str, text: &'static str, maka: &MakaPalette) -> AnyElement {
    div()
        .id(id)
        .test_support()
        .aria_label(text)
        .text_sm()
        .text_color(maka.ink_muted)
        .child(text)
        .into_any_element()
}

/// What filled the request, under the bar that says how full the window
/// is: estimates over bytes, never presented as a decomposition of the
/// reported prompt, so the heading says estimate and every figure carries
/// `≈`.
fn render_composition(state: &CompositionState, cx: &App) -> AnyElement {
    let locale = Locale::current(cx);
    let maka = cx.maka();
    let estimate = |tokens: u64| format!("≈{}", group_digits(tokens));
    let block = v_flex()
        .id("inspector-composition")
        .test_support()
        .w_full()
        .gap_2()
        .child(section_head("composition", copy::COMPOSITION.get(cx), None, maka.ink_muted, cx))
        .child(supporting(copy::COMPOSITION_BASIS.get(cx), maka.ink_muted));
    let composition = match state {
        CompositionState::Unrecorded => {
            return block
                .child(
                    div()
                        .id("inspector-composition-unrecorded")
                        .test_support()
                        .aria_label(copy::UNRECORDED.get(cx))
                        .child(supporting(copy::UNRECORDED.get(cx), maka.ink_muted)),
                )
                .into_any_element();
        }
        CompositionState::Available(composition) => composition,
    };
    let bands: Vec<(f64, Hsla)> = composition
        .parts
        .iter()
        .map(|part| (part.estimated_tokens as f64, part_fill(&part.kind, &maka)))
        .collect();
    let parts = composition.parts.iter().map(|part| {
        let (key, label) = part_label(&part.kind);
        fact_row(
            ("composition", key),
            Some(swatch(part_fill(&part.kind, &maka))),
            &label.map_or_else(
                || part.kind.as_str().to_owned(),
                |label| label.in_locale(locale).to_owned(),
            ),
            &estimate(part.estimated_tokens),
            cx,
        )
    });
    let mut tools: Vec<AnyElement> = composition
        .tools
        .iter()
        .map(|(name, tokens)| {
            let maka = cx.maka();
            h_flex()
                .id(domain_element_id("inspector-tool", name))
                .test_support()
                .aria_label(shell_copy::labeled(locale, name, &estimate(*tokens)))
                .w_full()
                .gap_3()
                .text_sm()
                .child(div().flex_1().min_w_0().text_color(maka.ink_muted).child(name.clone()))
                .child(
                    div()
                        .flex_none()
                        .font_features(tabular_nums())
                        .text_color(maka.ink)
                        .child(estimate(*tokens)),
                )
                .into_any_element()
        })
        .collect();
    if let Some((count, tokens)) = composition.remaining_tools {
        tools.push(fact_row(
            ("composition", "remaining-tools"),
            None,
            &copy::remaining_tools(locale, count),
            &estimate(tokens),
            cx,
        ));
    }
    if let Some(tokens) = composition.unlabelled_tools {
        tools.push(fact_row(
            ("composition", "unnamed-tools"),
            None,
            copy::UNNAMED_TOOLS.get(cx),
            &estimate(tokens),
            cx,
        ));
    }
    block
        .child(bar("composition", &bands, &maka))
        .child(v_flex().gap_1().children(parts))
        .when(!tools.is_empty(), |this| {
            this.child(
                div()
                    .pt_1()
                    .text_sm()
                    .font_medium()
                    .text_color(maka.ink_muted)
                    .child(copy::BY_TOOL.get(cx)),
            )
            .child(v_flex().gap_1().children(tools))
        })
        .into_any_element()
}

fn render_coverage(coverage: CoverageNotice, cx: &App) -> AnyElement {
    let locale = Locale::current(cx);
    let maka = cx.maka();
    let mut parts = Vec::new();
    if coverage.turns_missing > 0 {
        parts.push(copy::turns_missing(locale, coverage.turns_missing));
    }
    if coverage.turns_short > 0 {
        parts.push(copy::turns_short(locale, coverage.turns_short));
    }
    if coverage.unreadable_records > 0 {
        parts.push(copy::unreadable(locale, coverage.unreadable_records));
    }
    if coverage.oversized_runs > 0 {
        parts.push(copy::oversized(locale, coverage.oversized_runs));
    }
    let text = copy::coverage(locale, coverage.kind == CoverageKind::Absent, &parts);
    // Only the glyph carries the exception's ink: the notice comments on
    // the record, and must not out-shout the failures in it.
    h_flex()
        .id("inspector-coverage")
        .test_support()
        .aria_label(text.clone())
        .w_full()
        .items_start()
        .gap_1p5()
        .text_sm()
        .text_color(maka.ink_muted)
        .child(
            h_flex()
                .h_5()
                .flex_none()
                .child(Icon::new(IconName::TriangleAlert).size_3p5().text_color(maka.warning)),
        )
        .child(div().flex_1().min_w_0().child(text))
        .into_any_element()
}

// Words and colours.

/// The reason after [`copy::LOAD_FAILED`].
fn why(failure: &ReadFailure, locale: Locale) -> String {
    match failure {
        ReadFailure::NotConnected | ReadFailure::Transport(_) => {
            copy::WHY_DISCONNECTED.in_locale(locale).to_owned()
        }
        ReadFailure::Operation { message, .. } => copy::why_host(locale, message),
        _ => copy::WHY_UNEXPECTED.in_locale(locale).to_owned(),
    }
}

fn token_label(kind: TokenKind) -> Text {
    match kind {
        TokenKind::CacheRead => copy::TOKEN_CACHED,
        TokenKind::CacheMiss => copy::TOKEN_UNCACHED,
        TokenKind::Output => copy::TOKEN_OUTPUT,
    }
}

fn token_key(kind: TokenKind) -> &'static str {
    match kind {
        TokenKind::CacheRead => "cache-read",
        TokenKind::CacheMiss => "cache-miss",
        TokenKind::Output => "output",
    }
}

/// The prompt's tokens in the accent the context window draws a prompt in
/// (its cached share lighter, as there), what came back in neutral ink.
fn token_fill(kind: TokenKind, maka: &MakaPalette) -> Hsla {
    match kind {
        TokenKind::CacheRead => maka.accent.opacity(0.55),
        TokenKind::CacheMiss => maka.accent,
        TokenKind::Output => maka.ink_muted,
    }
}

/// The model's time in the accent, the tools' in neutral ink.
fn duration_fill(kind: DurationKind, maka: &MakaPalette) -> Hsla {
    match kind {
        DurationKind::Model => maka.accent,
        DurationKind::Tool => maka.ink_muted,
    }
}

/// The request's parts in steps of the accent, by their order on the wire.
fn part_fill(kind: &ContextSegmentKind, maka: &MakaPalette) -> Hsla {
    match kind {
        ContextSegmentKind::SystemInstructions => maka.accent,
        ContextSegmentKind::ToolDefinitions => maka.accent.opacity(0.7),
        ContextSegmentKind::Messages => maka.accent.opacity(0.45),
        _ => maka.accent.opacity(0.25),
    }
}

fn part_label(kind: &ContextSegmentKind) -> (&'static str, Option<Text>) {
    match kind {
        ContextSegmentKind::SystemInstructions => ("system", Some(copy::PART_SYSTEM)),
        ContextSegmentKind::ToolDefinitions => ("tools", Some(copy::PART_TOOLS)),
        ContextSegmentKind::Messages => ("messages", Some(copy::PART_MESSAGES)),
        ContextSegmentKind::Options => ("options", Some(copy::PART_OPTIONS)),
        _ => ("other", None),
    }
}

/// A step whose kind is its name (`inspectorStepKindLabel`); an unknown
/// kind reads as itself.
fn step_kind_label(kind: &StepKind, locale: Locale) -> String {
    match kind {
        StepKind::Permission => copy::STEP_PERMISSION.in_locale(locale).to_owned(),
        StepKind::Compaction => copy::STEP_COMPACTION.in_locale(locale).to_owned(),
        StepKind::Error => copy::STEP_ERROR.in_locale(locale).to_owned(),
        StepKind::Other(kind) => kind.clone(),
        StepKind::ModelCall => "model_call".to_owned(),
        StepKind::Tool => "tool".to_owned(),
    }
}

/// Why a model was called (`callKind`); a kind without a name here reads
/// as itself.
fn call_kind_label(kind: &ModelCallKind, locale: Locale) -> String {
    let text = match kind {
        ModelCallKind::MemoryExtraction => copy::CALL_MEMORY_EXTRACTION,
        ModelCallKind::SemanticCompact => copy::CALL_SEMANTIC_COMPACT,
        ModelCallKind::HistoryCompact => copy::CALL_HISTORY_COMPACT,
        ModelCallKind::GoalEvaluation => copy::CALL_GOAL_EVALUATION,
        ModelCallKind::SessionTitle => copy::CALL_SESSION_TITLE,
        ModelCallKind::SessionRecap => copy::CALL_SESSION_RECAP,
        ModelCallKind::PromptSuggestion => copy::CALL_PROMPT_SUGGESTION,
        ModelCallKind::DailyReview => copy::CALL_DAILY_REVIEW,
        other => return other.as_str().to_owned(),
    };
    text.in_locale(locale).to_owned()
}

/// How a permission request was answered (`permissionDecision`).
fn decision_label(decision: &str, locale: Locale) -> String {
    match decision {
        "allow" => copy::DECISION_ALLOW.in_locale(locale).to_owned(),
        "deny" => copy::DECISION_DENY.in_locale(locale).to_owned(),
        other => other.to_owned(),
    }
}

/// What ended a Turn badly (`turnFailure`), with a plain fallback for a
/// code nobody has named.
fn failure_label(code: Option<&str>) -> Text {
    match code.unwrap_or_default() {
        "tool_failed" => copy::FAILURE_TOOL,
        "model_call_failed" => copy::FAILURE_MODEL_CALL,
        "turn_aborted" => copy::FAILURE_ABORTED,
        "turn_cancelled" => copy::FAILURE_CANCELLED,
        "error" => copy::FAILURE_ERROR,
        _ => copy::FAILURE_TURN,
    }
}
