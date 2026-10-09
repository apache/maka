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

//! The conversation pane: the selected session's transcript as a
//! virtualized list, with its empty, loading, and failure states, and its
//! keyboard scrolling.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui_kit::base::{TextView, TextViewStyle};
use gpui_kit::component::bubble::{Bubble, BubbleContent, BubbleVariant};
use gpui_kit::component::button::{Button, ButtonRounded, ButtonVariants as _};
use gpui_kit::component::diff::{Diff, DiffFile, DiffHunkSeparator, DiffState};
use gpui_kit::component::message::MessageAlignment;
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::scroll::{ScrollableMask, Scrollbar};
use gpui_kit::component::shimmer::ShimmerText;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Selectable as _, Sizable as _, ThemeStyled as _,
    h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, Axis, ClipboardItem, Context, ElementId, Entity, FocusHandle,
    Focusable, FontWeight, HighlightStyle, Hsla, InteractiveElement as _, IntoElement, KeyBinding,
    ParentElement as _, Pixels, Render, Role, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, StyleRefinement, Styled as _, Subscription, Task,
    TestSupportExt as _, Transformation, WeakEntity, Window, div, percentage,
    prelude::FluentBuilder as _, relative,
};
use host_protocol::{InteractionAnswer, PermissionDecision, ProviderRetryPhase};
use transcript_model::{ToolStatus, TurnViewStatus};

use crate::composer::{attachment_chip, attachment_kind_icon};
use crate::paging::{PageDirection, Paging};
use crate::rows::{
    FooterRow, GroupPlace, HistoryRow, ListEdit, PromptAnswers, PromptBody, PromptRow, Row,
    RowBody, RowKey, RowOptions, SentAttachment, ThinkingRow, ToolDiff, ToolKind, ToolNote,
    ToolRow, build_rows, diff, reply_text,
};
use crate::state::{
    AnswerState, ConversationEvent, ConversationPhase, ConversationState, OlderHistory,
};
use crate::style::{
    BODY_LINE, BODY_SIZE, CODE_COMPACT_SIZE, CODE_LINE, CODE_SIZE, COLUMN_GUTTER, LABEL_SIZE,
    RADIUS_CHAT, RADIUS_CONTROL, RADIUS_MODAL, RADIUS_SURFACE, SUPPORTING_SIZE, column_max_width,
    dp, dp_px,
};
use crate::thinking_face::{self, thinking_face};
use crate::turn_status::{self, RetryCountdown, RunningLine};

/// Key context of the transcript. PageUp, PageDown, Home, and End scroll it
/// while it, or a control in one of its rows, has focus.
pub const TRANSCRIPT_CONTEXT: &str = "Transcript";

gpui_kit::actions!(
    transcript,
    [
        /// Scroll the transcript up by most of its visible height.
        ScrollPageUp,
        /// Scroll the transcript down by most of its visible height.
        ScrollPageDown,
        /// Scroll to the first message shown, and load earlier ones.
        ScrollToTop,
        /// Scroll to the latest message and follow new output again.
        ScrollToBottom,
    ]
);

/// Binds the transcript and message queue keys. Call once at startup,
/// before building menus.
pub fn init(cx: &mut App) {
    let context = Some(TRANSCRIPT_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("pageup", ScrollPageUp, context),
        KeyBinding::new("pagedown", ScrollPageDown, context),
        KeyBinding::new("home", ScrollToTop, context),
        KeyBinding::new("end", ScrollToBottom, context),
    ]);
    crate::queue::init(cx);
}
use shared::copy::conversation as copy;
use shared::copy::{self as shell_copy, Locale};
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, MakaPalette, floating_shadow, tabular_nums};
use shared::time::{local_utc_offset, relative_time};

/// How long a copy button shows that it copied.
const REPLY_COPIED_FOR: Duration = Duration::from_secs(2);

/// One frame of the running-turn spinner: about 30 Hz, under the 60 Hz
/// spinner limit in `AGENTS.md`. It rotates once a second.
const SPINNER_FRAME: Duration = Duration::from_millis(33);
const SPINNER_STEP: f32 = 0.033;

/// Wall-clock milliseconds since the Unix epoch, as the running turn's
/// clock reads them: the system clock, or a test's fake one.
type WallClock = Rc<dyn Fn(&App) -> u64>;

fn system_time_ms(_: &App) -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// What a turn footer reads off the clocks for one frame.
#[derive(Debug, Clone, Copy)]
struct FooterNow {
    /// Wall-clock milliseconds since the Unix epoch.
    wall_ms: u64,
    /// The local time zone's offset from UTC, in seconds east.
    utc_offset: i32,
    /// How long the live turn's scheduled provider retry still waits.
    retry_remaining_ms: Option<u64>,
}

/// How long the scheduled provider retry of turn `turn_id`'s footer still
/// waits, by `countdown` when it counts that retry.
fn retry_remaining_ms(
    countdown: Option<&RetryCountdown>,
    turn_id: &str,
    footer: &FooterRow,
    cx: &App,
) -> Option<u64> {
    let retry = footer.retry.as_ref()?;
    countdown
        .filter(|countdown| countdown.counts(turn_id, retry))
        .map(|countdown| countdown.remaining_ms(cx.background_executor().now()))
}

/// The transcript body's line height relative to its size: 14/22 (spec §7).
const BODY_LINE_HEIGHT: f32 = BODY_LINE / BODY_SIZE;
/// The fade under the plate's header, and its solid first part.
const TOP_FADE: f32 = 12.;
const TOP_FADE_SOLID: f32 = 6.;

/// Presents a [`ConversationState`].
///
/// Presentation owner of the centre pane. It keeps a row snapshot built from
/// the transcript on every commit of the state, diffs it by row identity
/// into splices and remeasures of the list, and renders rows from that
/// snapshot only. View-local choices (expanded Tool cards, options picked in
/// a question before answering) live here; everything the Host must know
/// goes through the state. The list is a [`MessageScroller`]: variable-height
/// rows, tail following while the reader is at the bottom, and a "Jump to
/// latest" button once they scroll up.
///
/// Older history: while the Session has messages before the ones shown, the
/// first row stands for them. When it scrolls into view (or Home is
/// pressed) the state reads the previous page; the row shows progress, and
/// the new rows go above without moving what is on screen: the topmost
/// visible row is scrolled back to where it was. Once the first message is
/// reached the row says so.
///
/// Keyboard: the transcript region is one Tab stop with a visible focus ring
/// while keyboard focus is on it; PageUp, PageDown, Home, and End scroll it
/// ([`TRANSCRIPT_CONTEXT`]). Every control in a row is a `Button` (a Tab
/// stop; Enter and Space activate it). No key answers a prompt except
/// activating its buttons; Escape in particular does nothing here.
pub struct ConversationView {
    state: Entity<ConversationState>,
    scroller: Entity<MessageScrollerState>,
    rows: Vec<Row>,
    options: RowOptions,
    /// Where each open row's details are scrolled, by expansion key: made
    /// when the row opens and dropped when it closes, so an open Tool
    /// output keeps its place while the transcript scrolls it out of view
    /// and back.
    detail_scrolls: HashMap<String, ScrollHandle>,
    /// The kit's Diff for each open card whose call returned a `file_diff`,
    /// by expansion key: parsed when the card opens or its diff changes,
    /// dropped when it closes. `None` when the parser rejects the diff and
    /// the card shows it as text.
    card_diffs: HashMap<String, CardDiff>,
    /// The transcript region's Tab stop; tracked only while a transcript is
    /// shown, since there is nothing to scroll otherwise.
    focus: FocusHandle,
    paging: Paging,
    /// Turns of the running-turn spinner, in `0..1`.
    spinner_turns: f32,
    /// Seconds into a streaming reasoning row's thinking face loop, in
    /// `0..thinking_face::LOOP_SECS`.
    face_secs: f32,
    /// The local time zone's offset from UTC, in seconds east, as of the
    /// last rebuild: turn footers past a week old show a local date.
    utc_offset: i32,
    /// The turn whose reply was just copied; its copy button shows a check
    /// until [`REPLY_COPIED_FOR`] passes.
    copied: Option<String>,
    /// What the running turn's clock reads.
    wall_clock: WallClock,
    /// The live running turn's scheduled provider retry, counted down from
    /// when this view first saw it.
    retry_countdown: Option<RetryCountdown>,
    _copied: Option<Task<()>>,
    _spinner: Option<Task<()>>,
    /// Redraws the live running turn's status line as its clock reaches
    /// each whole second; present only while that line has a clock.
    _clock: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ConversationView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConversationView").field("rows", &self.rows.len()).finish_non_exhaustive()
    }
}

impl ConversationView {
    pub fn new(state: Entity<ConversationState>, cx: &mut Context<Self>) -> Self {
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let subscriptions = vec![
            cx.subscribe(&state, |this, _, event: &ConversationEvent, cx| {
                let ConversationEvent::Changed { session_changed } = event;
                this.sync_rows(*session_changed, cx);
            }),
            // The rows carry prompt outcomes and grants in words; rebuild
            // them in the new language and measure every row again.
            cx.observe_global::<Locale>(|this, cx| {
                this.sync_rows(false, cx);
                let count = this.rows.len();
                this.scroller.update(cx, |scroller, cx| {
                    scroller.remeasure_items(0..count, cx);
                });
            }),
        ];
        let mut this = Self {
            state,
            scroller,
            rows: Vec::new(),
            options: RowOptions::default(),
            detail_scrolls: HashMap::new(),
            card_diffs: HashMap::new(),
            focus: cx.focus_handle().tab_stop(true),
            paging: Paging::default(),
            spinner_turns: 0.,
            face_secs: 0.,
            utc_offset: 0,
            copied: None,
            wall_clock: Rc::new(system_time_ms),
            retry_countdown: None,
            _copied: None,
            _spinner: None,
            _clock: None,
            _subscriptions: subscriptions,
        };
        this.sync_rows(true, cx);
        this
    }

    pub fn state(&self) -> &Entity<ConversationState> {
        &self.state
    }

    #[cfg(test)]
    pub(crate) fn rows(&self) -> &[Row] {
        &self.rows
    }

    #[cfg(test)]
    pub(crate) fn scroller(&self) -> &Entity<MessageScrollerState> {
        &self.scroller
    }

    /// Where the open row `expansion_key` has its details scrolled.
    #[cfg(test)]
    pub(crate) fn detail_scroll(&self, expansion_key: &str) -> Option<ScrollHandle> {
        self.detail_scrolls.get(expansion_key).cloned()
    }

    /// Reads the running turn's clock from `clock` instead of the system
    /// clock.
    #[cfg(test)]
    pub(crate) fn set_wall_clock(&mut self, clock: impl Fn(&App) -> u64 + 'static) {
        self.wall_clock = Rc::new(clock);
    }

    /// How far into its loop the thinking face of reasoning row
    /// `expansion_key` is drawn now, in seconds (0 at rest); `None` without
    /// that row.
    #[cfg(test)]
    pub(crate) fn thinking_face_secs(&self, expansion_key: &str, cx: &App) -> Option<f32> {
        self.rows.iter().find_map(|row| match &row.body {
            RowBody::Thinking(thinking) if thinking.expansion_key == expansion_key => {
                Some(drawn_face_secs(thinking.streaming, cx.reduce_motion(), self.face_secs))
            }
            _ => None,
        })
    }

    /// Whether the running turn's status line is being redrawn each second.
    #[cfg(test)]
    pub(crate) fn clock_ticks(&self) -> bool {
        self._clock.is_some()
    }

    /// What the running turn's clock reads now.
    #[cfg(test)]
    pub(crate) fn wall_now(&self, cx: &App) -> u64 {
        (self.wall_clock)(cx)
    }

    /// Rebuilds the row snapshot and applies the difference to the list.
    /// Rows inserted above the topmost visible row (older history) leave it
    /// where it was on screen.
    fn sync_rows(&mut self, session_changed: bool, cx: &mut Context<Self>) {
        if session_changed {
            self.options = RowOptions::default();
            self.detail_scrolls.clear();
            self.card_diffs.clear();
            self.rows.clear();
        }
        self.options.locale = Locale::current(cx);
        self.utc_offset = local_utc_offset();
        let (rows, older) = {
            let state = self.state.read(cx);
            let answers: PromptAnswers<'_> = &|id| state.answer_state(id).cloned();
            let older = state.older_history();
            let rows = match state.transcript() {
                Some(transcript) => {
                    build_rows(transcript, &older, answers, &self.options, &self.rows)
                }
                None => Vec::new(),
            };
            (rows, older)
        };
        let anchor = (!session_changed)
            .then(|| self.paging.top_anchor(|key| *key == RowKey::History))
            .flatten()
            .and_then(|anchor| {
                let old = self.rows.iter().position(|row| row.key == anchor.key)?;
                let new = rows.iter().position(|row| row.key == anchor.key)?;
                (old != new).then_some((anchor, new))
            });
        let edits = diff(&self.rows, &rows);
        let count = rows.len();
        self.scroller.update(cx, |scroller, cx| {
            if session_changed {
                scroller.reset(count, cx);
                return;
            }
            for edit in edits {
                let applied = match edit {
                    ListEdit::Splice { range, count } => scroller.splice(range, count, cx),
                    ListEdit::Remeasure(ix) => scroller.remeasure_items(ix..ix + 1, cx),
                };
                if !applied {
                    // Out of step with the list: start it over.
                    scroller.reset(count, cx);
                    break;
                }
            }
        });
        if let Some((anchor, index)) = anchor
            && !self.scroller.read(cx).is_following_tail()
        {
            self.paging.request(anchor);
            self.scroller.update(cx, |scroller, cx| {
                scroller.scroll_to_item(index, cx);
            });
        }
        self.rows = rows;
        self.sync_card_diffs(cx);
        if older == OlderHistory::Available {
            let view = cx.weak_entity();
            self.paging.when_history_visible(move |cx| {
                view.update(cx, |view, cx| view.load_older(cx)).ok();
            });
        } else {
            self.paging.forget_history_visible();
        }
        self.update_spinner(cx);
        self.note_retry(cx);
        self.update_clock(cx);
        cx.notify();
    }

    /// Parses the diff of each open card that has one and has not been
    /// parsed in its current form, and drops the Diffs of closed cards.
    fn sync_card_diffs(&mut self, cx: &mut Context<Self>) {
        let mut open = HashSet::new();
        for row in &self.rows {
            let RowBody::Tool(tool) = &row.body else { continue };
            let Some(diff) = &tool.diff else { continue };
            open.insert(tool.expansion_key.clone());
            if self.card_diffs.get(&tool.expansion_key).is_some_and(|card| card.text == diff.text) {
                continue;
            }
            let card = CardDiff::parse(diff, cx);
            self.card_diffs.insert(tool.expansion_key.clone(), card);
        }
        self.card_diffs.retain(|key, _| open.contains(key));
    }

    /// The kit's Diff of the open card `expansion_key`, when its diff
    /// parsed.
    #[cfg(test)]
    pub(crate) fn card_diff(&self, expansion_key: &str) -> Option<Entity<DiffState>> {
        self.card_diffs.get(expansion_key)?.state.clone()
    }

    /// Reads the previous page of older history, when there is one.
    fn load_older(&mut self, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.load_older_history(cx));
    }

    /// Runs the spinner clock while a turn, a Tool call or a reasoning
    /// runs and motion is allowed.
    fn update_spinner(&mut self, cx: &mut Context<Self>) {
        let running = self.rows.iter().any(|row| match &row.body {
            RowBody::Footer(footer) => footer.status == TurnViewStatus::Running,
            RowBody::Tool(tool) => tool.status == ToolStatus::Running,
            RowBody::Thinking(thinking) => thinking.streaming,
            _ => false,
        });
        if !running || cx.reduce_motion() {
            self._spinner = None;
            return;
        }
        if self._spinner.is_some() {
            return;
        }
        self._spinner = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(SPINNER_FRAME).await;
                let ticked = this.update(cx, |this, cx| {
                    this.spinner_turns = (this.spinner_turns + SPINNER_STEP).fract();
                    this.face_secs =
                        (this.face_secs + SPINNER_FRAME.as_secs_f32()) % thinking_face::LOOP_SECS;
                    cx.notify();
                });
                if ticked.is_err() {
                    break;
                }
            }
        }));
    }

    /// Runs the clock of the live running turn's status line while it has
    /// one (the elapsed time, or a retry's countdown), whatever the motion
    /// preference: elapsed time is information. Each tick lands on the
    /// clock's next whole second and redraws.
    fn update_clock(&mut self, cx: &mut Context<Self>) {
        let Some(first) = self.until_next_tick(cx) else {
            self._clock = None;
            return;
        };
        if self._clock.is_some() {
            return;
        }
        self._clock = Some(cx.spawn(async move |this, cx| {
            let mut wait = first;
            loop {
                cx.background_executor().timer(wait).await;
                let next = this.update(cx, |this, cx| {
                    cx.notify();
                    let next = this.until_next_tick(cx);
                    if next.is_none() {
                        // Nothing on the line moves any more (a countdown
                        // ran out); the next commit starts a new clock.
                        this._clock = None;
                    }
                    next
                });
                match next {
                    Ok(Some(next)) => wait = next,
                    _ => break,
                }
            }
        }));
    }

    /// How long until the live running turn's status line next changes.
    fn until_next_tick(&self, cx: &App) -> Option<Duration> {
        let (turn_id, footer) = self.live_running_footer()?;
        let remaining = retry_remaining_ms(self.retry_countdown.as_ref(), turn_id, footer, cx);
        turn_status::until_next_tick(footer, (self.wall_clock)(cx), remaining)
    }

    /// Starts counting down the live running turn's scheduled provider
    /// retry when it first shows, and forgets it once it goes.
    fn note_retry(&mut self, cx: &App) {
        let scheduled = self.live_running_footer().and_then(|(turn_id, footer)| {
            let retry = footer.retry.as_ref()?;
            (retry.phase == ProviderRetryPhase::Scheduled).then_some((turn_id, retry))
        });
        let Some((turn_id, retry)) = scheduled else {
            self.retry_countdown = None;
            return;
        };
        if self.retry_countdown.as_ref().is_some_and(|known| known.counts(turn_id, retry)) {
            return;
        }
        let received = cx.background_executor().now();
        let countdown = RetryCountdown::new(turn_id, retry, received, (self.wall_clock)(cx));
        self.retry_countdown = Some(countdown);
    }

    /// The footer of the live root turn while it runs, with its turn id.
    fn live_running_footer(&self) -> Option<(&str, &FooterRow)> {
        self.rows.iter().find_map(|row| match (&row.key, &row.body) {
            (RowKey::Footer { turn_id }, RowBody::Footer(footer))
                if footer.live && footer.status == TurnViewStatus::Running =>
            {
                Some((turn_id.as_str(), footer))
            }
            _ => None,
        })
    }

    /// Copies the reply of turn `turn_id` (its assistant text, in order) to
    /// the clipboard, and marks its copy button for a moment.
    fn copy_reply(&mut self, turn_id: &str, cx: &mut Context<Self>) {
        let text = self
            .state
            .read(cx)
            .transcript()
            .and_then(|transcript| transcript.turn(turn_id))
            .map(reply_text)
            .unwrap_or_default();
        if text.is_empty() {
            return;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.copied = Some(turn_id.to_owned());
        self._copied = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REPLY_COPIED_FOR).await;
            this.update(cx, |this, cx| {
                this.copied = None;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Expands or collapses a Tool card or a reasoning row.
    fn toggle_tool(&mut self, expansion_key: &str, cx: &mut Context<Self>) {
        if self.options.expanded.remove(expansion_key) {
            self.detail_scrolls.remove(expansion_key);
        } else {
            self.options.expanded.insert(expansion_key.to_owned());
            self.detail_scrolls.insert(expansion_key.to_owned(), ScrollHandle::new());
        }
        self.sync_rows(false, cx);
    }

    fn choose(
        &mut self,
        interaction_id: &str,
        question: usize,
        option: usize,
        cx: &mut Context<Self>,
    ) {
        let choices = self.options.choices.entry(interaction_id.to_owned()).or_default();
        if choices.len() <= question {
            choices.resize(question + 1, None);
        }
        choices[question] = Some(option);
        self.sync_rows(false, cx);
    }

    fn answer(&mut self, interaction_id: &str, answer: InteractionAnswer, cx: &mut Context<Self>) {
        self.state.update(cx, |state, cx| state.answer_interaction(interaction_id, answer, cx));
    }

    /// Scrolls one page, planned from the last painted frame; see
    /// [`crate::paging`].
    fn page(&mut self, direction: PageDirection, cx: &mut Context<Self>) {
        let rows = &self.rows;
        let Some(plan) = self.paging.plan(
            direction,
            |key| rows.iter().position(|row| &row.key == key),
            |ix| rows.get(ix).map(|row| row.key.clone()),
        ) else {
            return;
        };
        self.paging.request(plan.anchor);
        self.scroller.update(cx, |scroller, cx| {
            scroller.scroll_to_item(plan.scroll_to, cx);
        });
        cx.notify();
    }

    fn scroll_page_up(&mut self, _: &ScrollPageUp, _: &mut Window, cx: &mut Context<Self>) {
        self.page(PageDirection::Up, cx);
    }

    fn scroll_page_down(&mut self, _: &ScrollPageDown, _: &mut Window, cx: &mut Context<Self>) {
        self.page(PageDirection::Down, cx);
    }

    fn scroll_to_top(&mut self, _: &ScrollToTop, _: &mut Window, cx: &mut Context<Self>) {
        self.paging.cancel();
        self.scroller.update(cx, |scroller, cx| {
            scroller.scroll_to_item(0, cx);
        });
        self.load_older(cx);
        cx.notify();
    }

    fn scroll_to_bottom(&mut self, _: &ScrollToBottom, _: &mut Window, cx: &mut Context<Self>) {
        self.paging.cancel();
        self.scroller.update(cx, |scroller, cx| scroller.scroll_to_end(cx));
        cx.notify();
    }

    /// The line above a transcript that is shown while it does not follow
    /// the Host, in the reading column: reopening (the running icon and a
    /// muted line), a failure (the failed icon, what failed, why, and
    /// Retry), or the end of the session (the stopped icon and why), each
    /// in a quiet band with the `border` ring and radius 12. A lost
    /// connection has none: the window's disconnected strip already says
    /// so.
    fn render_status(
        &self,
        phase: &ConversationPhase,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let maka = cx.maka();
        let band = |id: &'static str| {
            h_flex()
                .id(id)
                .test_support()
                .w_full()
                .max_w(column_max_width())
                .min_h(dp(40.))
                .px(dp(12.))
                .gap(dp(10.))
                .rounded(dp(RADIUS_MODAL))
                .border_1()
                .border_color(maka.border)
                .text_size(dp(LABEL_SIZE))
        };
        let icon = |icon: MakaIcon, color: Hsla| {
            Icon::new(icon).with_size(dp_px(14., window)).text_color(color)
        };
        let element = match phase {
            ConversationPhase::Opening => band("conversation-status")
                .role(Role::Status)
                .aria_label(copy::REOPENING.get(cx))
                .text_color(maka.ink_muted)
                .child(running_icon(maka.ink_muted, 14., window))
                .child(copy::REOPENING.get(cx))
                .into_any_element(),
            ConversationPhase::Failed(message) => band("conversation-error")
                .role(Role::Alert)
                // The state's message leads with what failed, then why.
                .aria_label(message.clone())
                .child(icon(MakaIcon::StatusFailed, maka.destructive))
                .child(
                    div()
                        .flex_shrink_0()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(maka.ink)
                        .child(copy::OPEN_FAILED.get(cx)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(maka.ink_muted)
                        .children(open_failure_reason(message, cx)),
                )
                .child(self.retry_button(cx).ghost().small())
                .into_any_element(),
            ConversationPhase::Ended(message) => band("conversation-ended")
                .role(Role::Status)
                .aria_label(message.clone())
                .text_color(maka.ink_muted)
                .child(icon(MakaIcon::StatusStopped, maka.ink_muted))
                .child(div().min_w_0().truncate().child(message.clone()))
                .into_any_element(),
            _ => return None,
        };
        Some(
            h_flex()
                .flex_shrink_0()
                .w_full()
                .justify_center()
                .px(dp(COLUMN_GUTTER))
                .pt(dp(8.))
                .child(element)
                .into_any_element(),
        )
    }

    fn retry_button(&self, cx: &mut Context<Self>) -> Button {
        Button::new("conversation-retry").label(shared::copy::RETRY.get(cx)).on_click(cx.listener(
            |this, _, _, cx| {
                this.state.update(cx, |state, cx| state.retry(cx));
            },
        ))
    }

    /// What the pane shows instead of a transcript, centred in the reading
    /// column: while loading, Maka's running icon beside a muted line;
    /// otherwise a heading (16/600 ink) over an optional muted line.
    fn render_placeholder(
        &self,
        title: SharedString,
        body: Option<&'static str>,
        loading: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let content = if loading {
            h_flex()
                .gap(dp(8.))
                .text_size(dp(BODY_SIZE))
                .text_color(maka.ink_muted)
                .child(running_icon(maka.ink_muted, 16., window))
                .child(title.clone())
                .into_any_element()
        } else {
            v_flex()
                .items_center()
                .gap(dp(4.))
                .child(
                    div()
                        .text_size(dp(16.))
                        .line_height(dp(24.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(maka.ink)
                        .child(title.clone()),
                )
                .when_some(body, |this, body| {
                    this.child(
                        div()
                            .text_size(dp(BODY_SIZE))
                            .line_height(dp(BODY_LINE))
                            .text_color(maka.ink_muted)
                            .child(body),
                    )
                })
                .into_any_element()
        };
        v_flex()
            .id("conversation-placeholder")
            .test_support()
            .role(Role::Status)
            .aria_label(title)
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .px(dp(COLUMN_GUTTER))
            .text_center()
            .child(content)
            .into_any_element()
    }

    /// The pane when the session could not be opened at all: the failed
    /// icon, what failed (16/600 ink), why (muted), and Retry, centred.
    fn render_failure(
        &self,
        message: SharedString,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        v_flex()
            .id("conversation-placeholder")
            .test_support()
            .role(Role::Alert)
            // The state's message leads with what failed, then why.
            .aria_label(message.clone())
            .flex_1()
            .min_h_0()
            .items_center()
            .justify_center()
            .gap(dp(4.))
            .px(dp(COLUMN_GUTTER))
            .text_center()
            .child(
                Icon::new(MakaIcon::StatusFailed)
                    .with_size(dp_px(20., window))
                    .text_color(maka.destructive),
            )
            .child(
                div()
                    .id("conversation-error")
                    .test_support()
                    .pt(dp(4.))
                    .text_size(dp(16.))
                    .line_height(dp(24.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(maka.ink)
                    .child(copy::OPEN_FAILED.get(cx)),
            )
            .children(open_failure_reason(&message, cx).map(|reason| {
                div()
                    .max_w(column_max_width())
                    .text_size(dp(BODY_SIZE))
                    .line_height(dp(BODY_LINE))
                    .text_color(maka.ink_muted)
                    .child(reason)
            }))
            .child(div().pt(dp(12.)).child(shared::theme::quiet_button(self.retry_button(cx), cx)))
            .into_any_element()
    }

    /// The transcript region: the focusable owner of keyboard scrolling
    /// around the [`MessageScroller`], which owns the scroll position.
    fn render_transcript(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let view = cx.weak_entity();
        let focus_visible = self.focus.is_focused(window) && window.last_input_was_keyboard();
        let jump = copy::JUMP_TO_LATEST.get(cx);
        let list = MessageScroller::new(
            "conversation-transcript-list",
            self.scroller.clone(),
            move |ix, window, cx| render_row(&view, ix, window, cx),
        )
        .with_jump_button_label(jump)
        // A floating pill (DESIGN.md's floating recipe: overlay fill, a
        // border_soft ring, one soft shadow), so it stays legible over text.
        .with_jump_button_renderer({
            let maka = cx.maka();
            let shadow = floating_shadow(&maka, cx.theme().mode.is_dark());
            move |button| {
                button
                    .small()
                    .label(jump)
                    .border_1()
                    .border_color(maka.border_soft)
                    .bg(maka.overlay)
                    .text_color(maka.ink)
                    .shadow(shadow)
            }
        })
        // Rows carry their own vertical spacing (see `render_row`), so each
        // row's bounds cover its whole list item. The side inset keeps the
        // centred column off the pane edge in a narrow window, while the
        // scrollbar stays on that edge.
        .with_row_style(StyleRefinement::default().pb_0().px(dp(COLUMN_GUTTER)))
        .with_bottom_fade(cx.maka().plate)
        .size_full();
        div()
            .id("conversation-transcript")
            .test_support()
            .track_focus(&self.focus)
            .key_context(TRANSCRIPT_CONTEXT)
            .on_action(cx.listener(Self::scroll_page_up))
            .on_action(cx.listener(Self::scroll_page_down))
            .on_action(cx.listener(Self::scroll_to_top))
            .on_action(cx.listener(Self::scroll_to_bottom))
            .aria_label(copy::TRANSCRIPT.get(cx))
            .relative()
            .flex_1()
            .min_h_0()
            // Room for the focus ring, which is drawn outside the border and
            // would be clipped at the window edge.
            .m_1()
            .rounded(cx.theme().radius)
            .border_1()
            .border_color(cx.maka().plate)
            .when(focus_visible, |this| this.focus_ring_style(window, cx))
            .child(self.paging.viewport_probe())
            .child(list)
            // A 12pt fade at the top, so text scrolling under the header is
            // not cut mid-glyph: the first 6pt are the plate, hiding the clip
            // edge, then it clears within half a line, so no whole line
            // turns grey (review rounds 2, 4, 5 and 7). At rest it sits over
            // the transcript's own top padding.
            .child(div().absolute().top_0().left_0().right_0().h(dp(TOP_FADE)).bg(
                gpui_kit::linear_gradient(
                    180.,
                    gpui_kit::linear_color_stop(cx.maka().plate, TOP_FADE_SOLID / TOP_FADE),
                    gpui_kit::linear_color_stop(cx.maka().plate.opacity(0.), 1.),
                ),
            ))
            .into_any_element()
    }
}

impl Focusable for ConversationView {
    /// The transcript region's Tab stop.
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ConversationView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = self.state.read(cx);
        let phase = state.phase().clone();
        let has_transcript = state.transcript().is_some();
        let body = match (&phase, has_transcript) {
            (ConversationPhase::Idle, _) => self.render_placeholder(
                copy::NO_SESSION_TITLE.get(cx).into(),
                Some(copy::NO_SESSION_BODY.get(cx)),
                false,
                window,
                cx,
            ),
            (ConversationPhase::Failed(message), false) => {
                self.render_failure(message.clone(), window, cx)
            }
            (ConversationPhase::Ended(message), false) => {
                self.render_placeholder(message.clone(), None, false, window, cx)
            }
            (ConversationPhase::WaitingForHost, false) => self.render_placeholder(
                copy::WAITING_FOR_HOST.get(cx).into(),
                None,
                true,
                window,
                cx,
            ),
            (_, false) => {
                self.render_placeholder(copy::LOADING.get(cx).into(), None, true, window, cx)
            }
            (_, true) if self.rows.is_empty() => self.render_placeholder(
                copy::EMPTY_TITLE.get(cx).into(),
                Some(copy::EMPTY_BODY.get(cx)),
                false,
                window,
                cx,
            ),
            (_, true) => self.render_transcript(window, cx),
        };
        let status = if has_transcript { self.render_status(&phase, window, cx) } else { None };
        v_flex()
            .id("conversation")
            .test_support()
            // Fills the region it is given; inside a column it takes the
            // space the composer leaves.
            .size_full()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .children(status)
            .child(body)
    }
}

/// Renders row `ix` from the view's snapshot. Runs during the list's layout,
/// after the view's own render, so reading the view entity is safe.
fn render_row(
    view: &WeakEntity<ConversationView>,
    ix: usize,
    window: &Window,
    cx: &mut App,
) -> AnyElement {
    let Some(this) = view.upgrade() else {
        return div().into_any_element();
    };
    let (
        row,
        detail_scroll,
        card_diff,
        spinner_turns,
        face_secs,
        utc_offset,
        paging,
        copied,
        wall_clock,
        countdown,
    ) = {
        let this = this.read(cx);
        let row = this.rows.get(ix).cloned();
        let (detail_scroll, card_diff) = match row.as_ref().map(|row| &row.body) {
            Some(RowBody::Tool(tool)) => (
                this.detail_scrolls.get(&tool.expansion_key).cloned(),
                this.card_diffs.get(&tool.expansion_key).and_then(|card| card.state.clone()),
            ),
            _ => (None, None),
        };
        (
            row,
            detail_scroll,
            card_diff,
            this.spinner_turns,
            this.face_secs,
            this.utc_offset,
            this.paging.clone(),
            this.copied.clone(),
            this.wall_clock.clone(),
            this.retry_countdown.clone(),
        )
    };
    let Some(row) = row else {
        return div().into_any_element();
    };
    let id = row.key.element_id();
    let probe = paging.row_probe(row.key.clone());
    // Rows of one Tool group touch: the group is one container. A user
    // message stands 24 px off the reply that follows it; the items of one
    // turn sit 12 px apart.
    let space_below = match &row.body {
        RowBody::Tool(tool) if !tool.group.last => 0.,
        RowBody::User { .. } => 24.,
        _ => 12.,
    };
    let content = match row.body {
        RowBody::History(history) => render_history(history, view.clone(), window, cx),
        RowBody::User { text, attachments } => render_user(text, attachments, window, cx),
        RowBody::Thinking(thinking) => {
            render_thinking(thinking, face_secs, view.clone(), window, cx)
        }
        RowBody::Text { text, interrupted, .. } => {
            render_text(id.clone(), text, interrupted, window, cx)
        }
        RowBody::Tool(tool) => {
            render_tool(tool, detail_scroll, card_diff, spinner_turns, view.clone(), window, cx)
        }
        RowBody::Prompt(prompt) => render_prompt(prompt, view.clone(), cx),
        RowBody::Footer(footer) => {
            let turn_id = match &row.key {
                RowKey::Footer { turn_id } => turn_id.as_str(),
                _ => "",
            };
            let copied = copied.as_deref() == Some(turn_id);
            let now = FooterNow {
                wall_ms: wall_clock(cx),
                utc_offset,
                retry_remaining_ms: retry_remaining_ms(countdown.as_ref(), turn_id, &footer, cx),
            };
            render_footer(footer, turn_id, spinner_turns, now, copied, view.clone(), window, cx)
        }
    };
    h_flex()
        .relative()
        .w_full()
        .justify_center()
        // The user message that opens the next turn adds its own space
        // above.
        .pb(dp(space_below))
        .child(probe)
        .child(div().id(id).test_support().w_full().max_w(column_max_width()).child(content))
        .into_any_element()
}

/// The row above the first message: blank while older messages wait to be
/// loaded, Maka's running icon and a line while they load, the failure
/// (in the destructive tone) with Retry, or a muted "Beginning of task"
/// once the first message is shown. One line tall in every state, so
/// switching between them moves nothing.
fn render_history(
    history: HistoryRow,
    view: WeakEntity<ConversationView>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let label: Option<SharedString> = match &history {
        HistoryRow::More => None,
        HistoryRow::Loading => Some(copy::OLDER_HISTORY_LOADING.get(cx).into()),
        HistoryRow::Failed(message) => Some(message.clone()),
        HistoryRow::Beginning => Some(copy::TASK_BEGINNING.get(cx).into()),
    };
    h_flex()
        .id("transcript-history")
        .test_support()
        .role(Role::Status)
        .when_some(label.clone(), |this, label| this.aria_label(label))
        .w_full()
        .min_h(dp(32.))
        .justify_center()
        .gap(dp(6.))
        .text_size(dp(SUPPORTING_SIZE))
        .text_color(match history {
            HistoryRow::Failed(_) => maka.destructive,
            _ => maka.ink_muted,
        })
        .when(history == HistoryRow::Loading, |this| {
            this.child(running_icon(maka.ink_muted, 12., window))
        })
        .children(label)
        .when(matches!(history, HistoryRow::Failed(_)), |this| {
            this.child(
                Button::new("older-history-retry")
                    .ghost()
                    .xsmall()
                    .label(shared::copy::RETRY.get(cx))
                    .on_click(move |_, _, cx| {
                        view.update(cx, |view, cx| view.load_older(cx)).ok();
                    }),
            )
        })
        .into_any_element()
}

/// Why the session could not be opened, from the state's message, which
/// leads with "Couldn't open this session." (the heading the pane already
/// shows) and then gives the reason; `None` when there is no reason. A
/// message of another shape is shown whole.
fn open_failure_reason(message: &SharedString, cx: &App) -> Option<SharedString> {
    let what = copy::OPEN_FAILED.get(cx);
    match message.strip_prefix(what) {
        Some(reason) => Some(reason.trim())
            .filter(|reason| !reason.is_empty())
            .map(|reason| SharedString::from(reason.to_owned())),
        None => Some(message.clone()),
    }
}

/// Maka's running icon, turning with gpui-kit's spinner (which stands
/// still when motion is reduced), for waits the view does not clock.
fn running_icon(color: Hsla, size: f32, window: &Window) -> AnyElement {
    Spinner::new()
        .icon(MakaIcon::StatusRunning)
        .color(color)
        .with_size(dp_px(size, window))
        .into_any_element()
}

/// The user's message (spec §7): a trailing bubble at most 70% of the
/// column wide, bubble fill, no border, radius 28 (the chat rung it shares
/// with the composer dock), 10 / 18 padding, body 14/22 ink.
///
/// The files it carries sit above the bubble, trailing too, as the
/// composer's chips without the remove button, each led by its kind's
/// glyph. An image's is the file-image glyph where Maka Desktop shows a
/// thumbnail: its bytes are the Host's, and reading them back needs a
/// request this client does not make. A message of files alone has no
/// bubble, as in Maka Desktop.
fn render_user(
    text: SharedString,
    attachments: Vec<SentAttachment>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let chips = (!attachments.is_empty()).then(|| {
        h_flex().w_full().justify_end().flex_wrap().gap(dp(6.)).children(
            attachments.into_iter().map(|attachment| {
                let icon = attachment_kind_icon(&attachment.kind, window, cx);
                let id = attachment.element_id();
                attachment_chip(id, attachment.name, attachment.bytes, Some(icon), None, cx)
            }),
        )
    });
    let bubble = (!text.trim().is_empty()).then(|| {
        Bubble::new()
            .alignment(MessageAlignment::End)
            .with_variant(BubbleVariant::Muted)
            .max_w(relative(0.7))
            .content(
                BubbleContent::new()
                    .border_0()
                    .rounded(dp(RADIUS_CHAT))
                    .bg(maka.bubble)
                    .px(dp(18.))
                    .py(dp(10.))
                    .text_size(dp(BODY_SIZE))
                    .line_height(dp(BODY_LINE))
                    .text_color(maka.ink),
            )
            .child(text)
    });
    v_flex().w_full().pt(dp(16.)).gap(dp(6.)).children(chips).children(bubble).into_any_element()
}

/// Markdown in a reply (spec §7): headings 18, 16 and 14 (levels 1, 2,
/// then 3 and below); code blocks on the code tone, radius 10, 14 px at
/// the sides, mono 14/20; inline code on the `wash`; tables with
/// horizontal rules only (a `border` line under the header, `border_soft`
/// between body rows, no frame and no column rules), a 14/600 ink header
/// and 8 / 12 cell padding. Every size follows the window's rem, so
/// replies zoom with the rest.
///
/// This is gpui-kit's Base text view with the whole style given here: the
/// component wrapper folds a style onto the theme's and keeps the theme's
/// `border` for the rules between body rows, which Base takes from
/// [`TextViewStyle::with_border`]. That colour is also the kit's block
/// quote rule (2 px) and horizontal rule (1 px), so it is `border`: at the
/// soft 6% a quote's rule all but vanished (review round 7).
///
/// The kit's typography (gpui-kit 8d8cc671) sets the rest: the room above
/// a heading (a section gap in proportion to the heading, which the
/// paragraph gap counts towards) and below it (0.35 of its size), a code
/// block's 1 px rule, its language in the corner and the padding above and
/// below that clears it, inline code's 4 px side inset, list markers
/// hanging in a muted column with items 0.25em apart, and table body text
/// at 14/15 of the body size. Headings name their 600 weight, the kit's
/// default too, because the spec does.
fn message_text_style(window: &Window, cx: &App) -> TextViewStyle {
    let maka = cx.maka();
    let clear = Hsla::transparent_black();
    let body = dp_px(BODY_SIZE, window);
    TextViewStyle::default()
        .with_foreground(maka.ink)
        .with_muted_foreground(maka.ink_muted)
        .with_link(maka.primary)
        .with_selection(cx.theme().selection)
        .with_code_background(maka.code)
        .with_border(maka.border)
        .with_paragraph_gap(dp(16.))
        .with_heading(move |level| {
            StyleRefinement::default()
                .text_size(match level {
                    1 => body * (18. / BODY_SIZE),
                    2 => body * (16. / BODY_SIZE),
                    _ => body,
                })
                .font_weight(FontWeight::SEMIBOLD)
        })
        // The kit's top and bottom padding stay: the top grows to clear the
        // language it writes in the corner.
        .with_code_block(
            StyleRefinement::default()
                .bg(maka.code)
                .rounded(dp(RADIUS_SURFACE))
                .px(dp(14.))
                .text_size(dp(CODE_SIZE))
                .line_height(dp(CODE_LINE)),
        )
        .with_inline_code(HighlightStyle {
            background_color: Some(maka.wash),
            ..Default::default()
        })
        .with_table(StyleRefinement::default().bg(clear).border_0())
        .with_table_head(
            StyleRefinement::default()
                .bg(clear)
                .border_color(maka.border)
                .text_color(maka.ink)
                .text_size(dp(LABEL_SIZE))
                .font_weight(FontWeight::SEMIBOLD),
        )
        // 8.5 px above and below each line and the 1 px rule (DESIGN.md
        // §7). The kit draws the rule between columns in the cell's border
        // colour; clear, as the spec has no column rules.
        .with_table_cell(
            StyleRefinement::default().border_0().border_color(clear).px(dp(12.)).py(dp(8.5)),
        )
        .with_dark(cx.theme().mode.is_dark())
}

/// Assistant text as the transcript draws it, for
/// `examples/wrap_check.rs`, which renders it outside a transcript.
#[doc(hidden)]
pub fn assistant_text(
    id: impl Into<ElementId>,
    text: impl Into<SharedString>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    render_text(id.into(), text.into(), false, window, cx)
}

/// Assistant text: plain markdown on the plate, no bubble, body 14/22.
fn render_text(
    id: ElementId,
    text: SharedString,
    interrupted: bool,
    window: &Window,
    cx: &App,
) -> AnyElement {
    v_flex()
        .w_full()
        .gap_1()
        .when(!text.is_empty(), |this| {
            this.child(
                TextView::markdown(id, text)
                    .style(message_text_style(window, cx))
                    .selectable(true)
                    .w_full()
                    .text_size(dp(BODY_SIZE))
                    .line_height(relative(BODY_LINE_HEIGHT))
                    .text_color(cx.maka().ink),
            )
        })
        .when(interrupted, |this| {
            this.child(
                div()
                    .text_size(dp(SUPPORTING_SIZE))
                    .text_color(cx.maka().ink_muted)
                    .child(copy::TEXT_INTERRUPTED.get(cx)),
            )
        })
        .into_any_element()
}

/// An assistant step's reasoning (spec §7): a standalone row with the Tool
/// row's geometry and no ring. A 36 px button with the thinking face (16,
/// muted; [`thinking_face`]), the label (14/500 ink) in the 84 px name
/// lane, the first line (muted, cut with an ellipsis) once the reasoning is
/// complete, and the chevron on hover or while open; the hover wash has
/// radius 10. While the reasoning streams the face thinks, `face_secs` into
/// its loop, and the label shimmers ("Thinking…"); with reduced motion both
/// are still, and a finished row's face rests. Open, the whole reasoning
/// sits below in muted 14/20, inset 38 px under the label. Never part of
/// the reply's text.
fn render_thinking(
    row: ThinkingRow,
    face_secs: f32,
    view: WeakEntity<ConversationView>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let key = row.expansion_key.clone();
    let hover_group = SharedString::from(format!("thinking-row:{}", row.expansion_key));
    let chevron = if row.expanded { MakaIcon::ChevronDown } else { MakaIcon::ChevronRight };
    let label =
        if row.streaming { copy::THINKING_STREAMING.get(cx) } else { copy::THINKING.get(cx) };
    let header = Button::new("thinking-toggle")
        .ghost()
        .w_full()
        .h(dp(36.))
        .px(dp(12.))
        .rounded(dp_px(RADIUS_SURFACE, window))
        .group(hover_group.clone())
        .accessibility_label(shell_copy::phrases(
            Locale::current(cx),
            label,
            if row.expanded { copy::HIDE_REASONING.get(cx) } else { copy::SHOW_REASONING.get(cx) },
        ))
        .on_click(move |_, _, cx| {
            view.update(cx, |view, cx| view.toggle_tool(&key, cx)).ok();
        })
        .child(
            h_flex()
                .w_full()
                .min_w_0()
                .gap(dp(10.))
                .child(thinking_face(
                    drawn_face_secs(row.streaming, cx.reduce_motion(), face_secs),
                    dp_px(16., window),
                    maka.ink_muted,
                ))
                .child(
                    div()
                        .flex_shrink_0()
                        .w(dp(TOOL_NAME_LANE))
                        .truncate()
                        .text_size(dp(LABEL_SIZE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(maka.ink)
                        .child(if row.streaming {
                            ShimmerText::new(label).into_any_element()
                        } else {
                            div().child(label).into_any_element()
                        }),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(dp(SUPPORTING_SIZE))
                        .text_color(maka.ink_muted)
                        .children(row.preview.clone()),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .when(!row.expanded, |this| {
                            this.opacity(0.).group_hover(hover_group, |style| style.opacity(1.))
                        })
                        .child(
                            Icon::new(chevron)
                                .with_size(dp_px(14., window))
                                .text_color(maka.ink_muted),
                        ),
                ),
        );
    v_flex()
        .id("thinking")
        .test_support()
        .w_full()
        .child(header)
        .when_some(row.text.clone(), |this, text| {
            this.child(
                v_flex()
                    .id("thinking-text")
                    .test_support()
                    .aria_label(text.clone())
                    .gap(dp(4.))
                    .pl(dp(38.))
                    .pr(dp(12.))
                    .pt(dp(2.))
                    .pb(dp(8.))
                    .text_size(dp(BODY_SIZE))
                    .line_height(dp(20.))
                    .text_color(maka.ink_muted)
                    .child(text)
                    .when(row.truncated, |this| {
                        this.child(
                            div()
                                .text_size(dp(SUPPORTING_SIZE))
                                .child(copy::THINKING_TRUNCATED.get(cx)),
                        )
                    }),
            )
        })
        .into_any_element()
}

/// How far into its loop a reasoning row's thinking face is drawn: `secs`
/// while the reasoning streams and motion is allowed, otherwise 0, the
/// rest pose.
fn drawn_face_secs(streaming: bool, reduce_motion: bool, secs: f32) -> f32 {
    if streaming && !reduce_motion { secs } else { 0. }
}

/// A Tool call's status as its row shows it (spec §7): the icon, its
/// colour, and the word its accessible name uses. Each status has its own
/// shape, so colour is never the only difference.
fn tool_status(status: ToolStatus, waiting: bool, cx: &App) -> (MakaIcon, &'static str, Hsla) {
    let maka = cx.maka();
    if waiting {
        return (MakaIcon::StatusWaiting, copy::TOOL_WAITING.get(cx), maka.warning);
    }
    match status {
        ToolStatus::Running => (MakaIcon::StatusRunning, copy::TOOL_RUNNING.get(cx), maka.primary),
        ToolStatus::Completed => (MakaIcon::StatusDone, copy::TOOL_DONE.get(cx), maka.ink_muted),
        ToolStatus::Errored => {
            (MakaIcon::StatusFailed, copy::TOOL_FAILED.get(cx), maka.destructive)
        }
        _ => (MakaIcon::StatusStopped, copy::TOOL_STOPPED.get(cx), maka.ink_muted),
    }
}

/// How much of an open Tool row's text shows before it scrolls: 256 px, as
/// Maka Desktop's `.maka-tool-output-body` (`max-height: 256px`), about
/// twelve and a half 20 px lines, so the cut line says there is more.
const TOOL_OUTPUT_MAX_TEXT: f32 = 256.;

/// The tool-name lane: wide enough for every name a user meets ("Permission",
/// "WebSearch") at 14/500, so summaries start on one vertical line.
const TOOL_NAME_LANE: f32 = 84.;

/// The icon of a kind of Tool (spec §7).
fn tool_icon(kind: ToolKind) -> MakaIcon {
    match kind {
        ToolKind::Terminal => MakaIcon::ToolTerminal,
        ToolKind::Read => MakaIcon::ToolRead,
        ToolKind::Edit => MakaIcon::ToolEdit,
        ToolKind::Search => MakaIcon::ToolSearch,
        ToolKind::Web => MakaIcon::ToolWeb,
        ToolKind::Plug => MakaIcon::ToolPlug,
    }
}

/// A Tool call (spec §7 of `docs/design/polish-2026-09-26.md`).
/// Consecutive calls share one container: radius 12 and a 1 px `border`
/// ring on the plate, drawn in pieces by the rows themselves (the first
/// row the top edge, the last the bottom, the rest a `border_soft` divider
/// above them), so each call stays its own row of the virtual list.
///
/// The header is one 36 px button that toggles the details: the kind icon
/// (16, muted), the name (14/500 ink) in the 84 px lane, the summary (mono
/// 12, muted, cut with an ellipsis), the diff counts when the result
/// carries a diff, the status icon (14; running turns while motion is
/// allowed), and a chevron that shows on hover and while open. Open, the
/// output (or, before there is one, the input) sits below on the code tone,
/// inset 38 px so it starts under the name; past 256 px of text it scrolls
/// (see [`tool_detail`]).
fn render_tool(
    tool: ToolRow,
    detail_scroll: Option<ScrollHandle>,
    card_diff: Option<Entity<DiffState>>,
    spinner_turns: f32,
    view: WeakEntity<ConversationView>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let (status_icon, label, status_color) = tool_status(tool.status, tool.waiting, cx);
    let key = tool.expansion_key.clone();
    let GroupPlace { first, last } = tool.group;
    // A lone, closed call is a bare row like the reasoning row (radius-10
    // hover wash, no ring); a group or an open call gets the ring.
    let solo = first && last && !tool.expanded;
    // The hover wash stays inside the ring's rounded corners.
    let inner = if solo { dp_px(RADIUS_SURFACE, window) } else { dp_px(RADIUS_MODAL - 1., window) };
    let hover_group = SharedString::from(format!("tool-row:{}", tool.expansion_key));
    let mut status = Icon::new(status_icon).with_size(dp_px(14., window)).text_color(status_color);
    if tool.status == ToolStatus::Running && !cx.reduce_motion() {
        status = status.transform(Transformation::rotate(percentage(spinner_turns)));
    }
    let chevron = if tool.expanded { MakaIcon::ChevronDown } else { MakaIcon::ChevronRight };
    let header = Button::new("tool-toggle")
        .ghost()
        .w_full()
        .h(dp(36.))
        .px(dp(12.))
        .rounded(ButtonRounded::None)
        .when(first, |this| this.rounded_t(inner))
        .when(last && !tool.expanded, |this| this.rounded_b(inner))
        .group(hover_group.clone())
        // The row reads as cells; name what pressing it does instead.
        .accessibility_label(shell_copy::phrases(
            Locale::current(cx),
            &shell_copy::parts(Locale::current(cx), &[&tool.name, label]),
            if tool.expanded { copy::HIDE_DETAILS.get(cx) } else { copy::SHOW_DETAILS.get(cx) },
        ))
        .on_click(move |_, _, cx| {
            view.update(cx, |view, cx| view.toggle_tool(&key, cx)).ok();
        })
        .child(
            h_flex()
                .w_full()
                .min_w_0()
                .gap(dp(10.))
                .child(
                    Icon::new(tool_icon(tool.kind))
                        .with_size(dp_px(16., window))
                        .text_color(maka.ink_muted),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .w(dp(TOOL_NAME_LANE))
                        .truncate()
                        .text_size(dp(LABEL_SIZE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(maka.ink)
                        .child(tool.name.clone()),
                )
                .child(
                    h_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(dp(6.))
                        .font_family(cx.theme().mono_font_family.clone())
                        .text_size(dp(CODE_COMPACT_SIZE))
                        .child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_color(maka.ink_muted)
                                .children(tool.summary.clone()),
                        )
                        .when(tool.added > 0, |this| {
                            this.child(
                                div()
                                    .flex_shrink_0()
                                    .text_color(maka.success)
                                    .child(format!("+{}", tool.added)),
                            )
                        })
                        .when(tool.removed > 0, |this| {
                            this.child(
                                div()
                                    .flex_shrink_0()
                                    .text_color(maka.destructive)
                                    .child(format!("\u{2212}{}", tool.removed)),
                            )
                        }),
                )
                // While its prompt card waits below, the card carries the one
                // attention glyph; the row keeps the slot, so chevrons stay on
                // one edge (review round 5).
                .map(|this| {
                    if tool.waiting {
                        this.child(div().flex_shrink_0().size(dp(14.)))
                    } else {
                        this.child(status)
                    }
                })
                .child(
                    div()
                        .flex_shrink_0()
                        // A failure's chevron always shows, so what went wrong
                        // is visibly one click away (DESIGN.md §11, first Do);
                        // a call waiting on the user is not a failure.
                        .when(
                            !tool.expanded && (tool.status != ToolStatus::Errored || tool.waiting),
                            |this| {
                                this.opacity(0.).group_hover(hover_group, |style| style.opacity(1.))
                            },
                        )
                        .child(
                            Icon::new(chevron)
                                .with_size(dp_px(14., window))
                                .text_color(maka.ink_muted),
                        ),
                ),
        );
    v_flex()
        .w_full()
        .bg(maka.plate)
        .when(!solo, |this| {
            this.border_color(maka.border)
                .border_l_1()
                .border_r_1()
                .when(first, |this| this.border_t_1().rounded_t(dp(RADIUS_MODAL)))
                .when(last, |this| this.border_b_1().rounded_b(dp(RADIUS_MODAL)))
        })
        .when(!first, |this| this.child(div().w_full().h_px().bg(maka.border_soft)))
        .child(header)
        .when(tool.expanded, |this| {
            this.child(tool_detail(&tool, detail_scroll.unwrap_or_default(), card_diff, window, cx))
        })
        .into_any_element()
}

/// What an open Tool row shows: the diff a Write or Edit returned, its
/// output, or its input before there is any output (as Maka Desktop does),
/// or a note that says why there is none of them ([`ToolNote`]).
///
/// The block is its own scroll owner, held at `scroll`: it shows up to 256
/// px of text (Desktop's `.maka-tool-output-body`) inside its padding and
/// scrolls the rest, with the kit's scrollbar on its edge. Long lines wrap.
/// The transcript's [`MessageScroller`] takes vertical wheel input in the
/// capture phase whenever the transcript can move, before any row sees it,
/// so the block carries a [`ScrollableMask`] of its own: painted inside the
/// list, it runs first, scrolls the block while it has more to show, and
/// leaves the event to the transcript at either end.
///
/// A diff shows in the kit's [`Diff`] ([`diff_block`]); one its parser
/// rejects shows as text, as before.
fn tool_detail(
    tool: &ToolRow,
    scroll: ScrollHandle,
    card_diff: Option<Entity<DiffState>>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let diff = tool.diff.as_ref().zip(card_diff);
    let body = match (diff, tool.output.clone().or_else(|| tool.input.clone())) {
        (Some((diff, state)), _) => diff_block(diff, state, &scroll, window, cx),
        (None, Some(text)) => div()
            .relative()
            .w_full()
            .child(
                div()
                    .id("tool-output")
                    .test_support()
                    .w_full()
                    .max_h(dp(TOOL_OUTPUT_MAX_TEXT + 20.))
                    .overflow_y_scroll()
                    // A sideways swipe never scrolls the block down.
                    .restrict_scroll_to_axis()
                    .track_scroll(&scroll)
                    .rounded(dp(RADIUS_SURFACE))
                    .bg(maka.code)
                    .px(dp(12.))
                    .py(dp(10.))
                    .font_family(cx.theme().mono_font_family.clone())
                    .text_size(dp(CODE_COMPACT_SIZE))
                    .line_height(dp(CODE_LINE))
                    .text_color(maka.ink)
                    .child(text),
            )
            .child(ScrollableMask::new(Axis::Vertical, &scroll))
            .child(Scrollbar::vertical(&scroll))
            .into_any_element(),
        (None, None) => div()
            .id("tool-note")
            .test_support()
            .text_size(dp(SUPPORTING_SIZE))
            .text_color(maka.ink_muted)
            .child(
                match tool.note {
                    ToolNote::NoOutputYet => copy::TOOL_NO_OUTPUT,
                    ToolNote::OutputAtTurnEnd => copy::TOOL_OUTPUT_AT_TURN_END,
                    ToolNote::NoOutput => copy::TOOL_OUTPUT_NONE,
                }
                .get(cx),
            )
            .into_any_element(),
    };
    // Balanced on the text, not the boxes: the row's label line ends 8 px
    // above the row's edge, so 2 px more leaves about 12 px under the
    // label's descenders, the 12 px the block keeps above the next divider
    // (review round 4).
    div().w_full().pl(dp(38.)).pr(dp(12.)).pt(dp(2.)).pb(dp(12.)).child(body).into_any_element()
}

/// A Write or Edit's diff in the kit's [`Diff`]: readonly, unified, line
/// numbers, added and removed lines in the theme's `success` and `danger`
/// tints, no syntax colour, and long lines scrolling sideways as Desktop's
/// preview does (`white-space: pre`). The card's header already names the
/// call and its counts, so the Diff draws no file header, and a thin rule
/// stands between hunks where Desktop draws nothing.
///
/// The Diff scrolls its rows in a list of its own, which the kit keeps
/// private: no mask can be bound to it, and the transcript's capture-phase
/// mask would take the wheel from it whenever the transcript can move. So
/// the Diff is laid out at its whole height (its rows, at the kit's row
/// height, and a 0.25rem rule per hunk; its list then never scrolls), and
/// the block around it is the scroll owner with the 256 px cap and the mask,
/// exactly as for text. Past Desktop's 500 lines the rest is left out and
/// a note under the block says how many lines that is.
fn diff_block(
    diff: &ToolDiff,
    state: Entity<DiffState>,
    scroll: &ScrollHandle,
    window: &Window,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    let rem = window.rem_size();
    // Each row of the Diff's list is laid out on its own, its height
    // rounded to the device pixel.
    let scale = window.scale_factor();
    let snap = |length: Pixels| (length * scale).round() / scale;
    // The kit's code row: the theme's mono size on the window's rem, 1.6
    // lines high (`render_diff` in gpui-component's diff module); a simple
    // hunk rule is 0.25rem.
    let row = snap(rem * (f32::from(cx.theme().mono_font_size) / 16.) * 1.6);
    let rule = snap(rem * 0.25);
    let height = row * diff.rows.rows as f32 + rule * diff.rows.hunks as f32;
    v_flex()
        .w_full()
        .gap(dp(6.))
        .child(
            div()
                .relative()
                .w_full()
                .child(
                    div()
                        .id("tool-diff")
                        .test_support()
                        .w_full()
                        .max_h(dp(TOOL_OUTPUT_MAX_TEXT + 20.))
                        .overflow_y_scroll()
                        .restrict_scroll_to_axis()
                        .track_scroll(scroll)
                        .rounded(dp(RADIUS_SURFACE))
                        .bg(maka.code)
                        .py(dp(10.))
                        .child(
                            Diff::new(&state)
                                .header_visible(false)
                                .syntax_highlight(false)
                                .hunk_separator(DiffHunkSeparator::Simple)
                                .w_full()
                                .h(height)
                                .border_0()
                                .bg(Hsla::transparent_black()),
                        ),
                )
                .child(ScrollableMask::new(Axis::Vertical, scroll))
                .child(Scrollbar::vertical(scroll)),
        )
        .when(diff.hidden_lines > 0, |this| {
            this.child(
                div()
                    .id("tool-diff-hidden")
                    .test_support()
                    .text_size(dp(SUPPORTING_SIZE))
                    .text_color(maka.ink_muted)
                    .child(copy::tool_diff_hidden_lines(Locale::current(cx), diff.hidden_lines)),
            )
        })
        .into_any_element()
}

/// An open card's diff in the kit's Diff, or `None` when its parser
/// rejects it (or it has no hunk to lay out) and the card shows it as
/// text.
struct CardDiff {
    text: SharedString,
    state: Option<Entity<DiffState>>,
}

impl CardDiff {
    fn parse(diff: &ToolDiff, cx: &mut App) -> Self {
        let files = DiffFile::parse(&diff.text).ok().filter(|files| !files.is_empty());
        let state = files.filter(|_| diff.rows.hunks > 0).map(|files| {
            // Every line the diff carries shows: nothing to fold.
            cx.new(|cx| DiffState::new(files, cx).with_context_lines(None))
        });
        Self { text: diff.text.clone(), state }
    }
}

/// What a boundary request grants, one sentence per line on the code tone:
/// the words in the body face and each path in the mono face, so the block
/// reads as what is allowed, not as a command, and Chinese never falls back
/// inside a mono run (review round 7).
fn grant_lines(grants: &[crate::rows::SandboxGrant], cx: &App) -> AnyElement {
    let maka = cx.maka();
    let body = gpui_kit::font(cx.theme().font_family.clone());
    let mono = gpui_kit::font(cx.theme().mono_font_family.clone());
    let run = |len: usize, font: &gpui_kit::Font| gpui_kit::TextRun {
        len,
        font: font.clone(),
        color: maka.ink,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    v_flex()
        .w_full()
        .min_w_0()
        .gap(dp(2.))
        .rounded(dp(RADIUS_SURFACE))
        .bg(maka.code)
        .px(dp(12.))
        .py(dp(10.))
        .text_size(dp(BODY_SIZE))
        .line_height(dp(CODE_LINE))
        .children(grants.iter().map(|grant| {
            let text = grant.text.clone();
            let at = grant
                .path
                .as_ref()
                .and_then(|path| text.find(path.as_ref()).map(|at| (at, path.len())));
            let runs = match at {
                Some((at, len)) => {
                    let rest = text.len() - at - len;
                    [(at, &body), (len, &mono), (rest, &body)]
                        .into_iter()
                        .filter(|(len, _)| *len > 0)
                        .map(|(len, font)| run(len, font))
                        .collect()
                }
                None => vec![run(text.len(), &body)],
            };
            gpui_kit::StyledText::new(text).with_runs(runs)
        }))
        .into_any_element()
}

/// Machine text in a prompt (a command, a path, arguments): the code tone,
/// radius 10, mono 14/20 (spec §7).
fn code_block(text: SharedString, cx: &App) -> AnyElement {
    div()
        .w_full()
        .min_w_0()
        .rounded(dp(RADIUS_SURFACE))
        .bg(cx.maka().code)
        .px(dp(12.))
        .py(dp(10.))
        .text_size(dp(CODE_SIZE))
        .line_height(dp(CODE_LINE))
        .font_family(cx.theme().mono_font_family.clone())
        .child(text)
        .into_any_element()
}

/// `Allow` and `Deny` for a prompt that takes a yes-or-no decision. While one
/// answer is in flight that button shows progress and neither takes input.
fn decision_buttons(
    prompt: &PromptRow,
    allow: InteractionAnswer,
    deny: InteractionAnswer,
    view: &WeakEntity<ConversationView>,
    locale: Locale,
    palette: MakaPalette,
) -> AnyElement {
    let (muted, cx_plate, cx_border) = (palette.ink_muted, palette.plate, palette.border);
    let sending = match &prompt.answer {
        Some(AnswerState::Sending(answer)) => Some(answer.clone()),
        _ => None,
    };
    let button = |id: &'static str, label: &'static str, answer: InteractionAnswer| {
        let (view, interaction_id) = (view.clone(), prompt.interaction_id.clone());
        let this_one = sending.as_ref() == Some(&answer);
        // Allow is the one solid control; Deny stays quiet beside it.
        let button = Button::new(id);
        // Deny: the plate fill and a `border` ring, one separator on its edge.
        let button = if id == "allow" {
            button.primary()
        } else {
            button.outline().bg(cx_plate).border_color(cx_border)
        };
        // Maka's control recipe: 32pt, radius 10, 14/500 label.
        let button = shared::theme::control_button(button);
        button.label(label).loading(this_one).disabled(sending.is_some() && !this_one).on_click(
            move |_, _, cx| {
                let answer = answer.clone();
                view.update(cx, |view, cx| view.answer(&interaction_id, answer, cx)).ok();
            },
        )
    };
    h_flex()
        .gap_2()
        .child(button("allow", copy::ALLOW.in_locale(locale), allow))
        .child(button("deny", copy::DENY.in_locale(locale), deny))
        .child(div().flex_1())
        .child(
            div()
                .id("prompt-waiting")
                .test_support()
                .aria_label(copy::TURN_WAITING.in_locale(locale))
                .flex_shrink_0()
                .text_size(dp(SUPPORTING_SIZE))
                .text_color(muted)
                .child(copy::TURN_WAITING.in_locale(locale)),
        )
        .into_any_element()
}

/// A prompt the turn waits on, inline at its place in the transcript.
fn render_prompt(prompt: PromptRow, view: WeakEntity<ConversationView>, cx: &App) -> AnyElement {
    let pending = prompt.is_pending();
    let failure = prompt.failure().cloned();
    let (title, content): (SharedString, AnyElement) = match &prompt.body {
        PromptBody::Permission { tool_name, detail, outcome } => {
            let content = v_flex()
                .gap_2()
                .when_some(detail.clone(), |this, detail| this.child(code_block(detail, cx)))
                .when(pending, |this| {
                    this.child(decision_buttons(
                        &prompt,
                        InteractionAnswer::allow_once(),
                        InteractionAnswer::deny(),
                        &view,
                        Locale::current(cx),
                        cx.maka(),
                    ))
                })
                .when_some(outcome.clone(), |this, outcome| this.child(outcome_line(outcome, cx)))
                .into_any_element();
            (copy::permission_title(Locale::current(cx), tool_name).into(), content)
        }
        PromptBody::SandboxBoundary { justification, grants, outcome } => {
            let content = v_flex()
                .gap_2()
                .when_some(justification.clone(), |this, justification| {
                    this.child(div().text_sm().child(justification))
                })
                .when(!grants.is_empty(), |this| this.child(grant_lines(grants, cx)))
                .when(pending, |this| {
                    this.child(decision_buttons(
                        &prompt,
                        InteractionAnswer::SandboxBoundary { decision: PermissionDecision::Allow },
                        InteractionAnswer::SandboxBoundary { decision: PermissionDecision::Deny },
                        &view,
                        Locale::current(cx),
                        cx.maka(),
                    ))
                })
                .when_some(outcome.clone(), |this, outcome| this.child(outcome_line(outcome, cx)))
                .into_any_element();
            (copy::SANDBOX_TITLE.get(cx).into(), content)
        }
        PromptBody::Question { questions, selected, outcome } => (
            copy::QUESTION_TITLE.get(cx).into(),
            render_question(&prompt, questions, selected, outcome, &view, cx),
        ),
        PromptBody::Unsupported { outcome } => {
            let content = v_flex()
                .gap_2()
                .child(
                    div()
                        .text_size(dp(BODY_SIZE))
                        .text_color(cx.maka().ink_muted)
                        .child(copy::UNSUPPORTED_PROMPT.get(cx)),
                )
                .when_some(outcome.clone(), |this, outcome| this.child(outcome_line(outcome, cx)))
                .into_any_element();
            (copy::QUESTION_TITLE.get(cx).into(), content)
        }
    };
    let maka = cx.maka();
    // The ring is always `border` (DESIGN.md §8: a surface's edge never
    // repeats its status); the waiting glyph in the warning tone and the
    // words say that the prompt waits.
    let accent = if pending { maka.warning } else { maka.ink_muted };
    v_flex()
        .w_full()
        .gap_2()
        .p(dp(12.))
        .rounded(dp(RADIUS_MODAL))
        .border_1()
        .border_color(maka.border)
        .bg(maka.plate)
        .child(
            h_flex()
                .id("prompt-title")
                .test_support()
                .aria_label(title.clone())
                .gap_2()
                .child(
                    Icon::new(if pending { MakaIcon::StatusWaiting } else { MakaIcon::StatusDone })
                        .size_4()
                        .text_color(accent),
                )
                .child(
                    div()
                        .text_size(dp(BODY_SIZE))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(maka.ink)
                        .child(title),
                ),
        )
        .child(content)
        .when_some(failure, |this, failure| {
            this.child(
                div()
                    .id("answer-error")
                    .test_support()
                    .aria_label(failure.clone())
                    .text_size(dp(SUPPORTING_SIZE))
                    .text_color(maka.destructive)
                    .child(failure),
            )
        })
        .into_any_element()
}

fn render_question(
    prompt: &PromptRow,
    questions: &[crate::rows::QuestionRow],
    selected: &[Option<usize>],
    outcome: &Option<SharedString>,
    view: &WeakEntity<ConversationView>,
    cx: &App,
) -> AnyElement {
    let pending = prompt.is_pending();
    let sending = prompt.is_sending();
    let complete = selected.iter().all(Option::is_some);
    let answers: Vec<Option<String>> = questions
        .iter()
        .zip(selected)
        .map(|(question, choice)| choice.map(|ix| question.options[ix].to_string()))
        .collect();
    let interaction_id = prompt.interaction_id.clone();
    v_flex()
        .gap_3()
        .children(questions.iter().enumerate().map(|(q, question)| {
            v_flex().gap_1p5().child(div().text_sm().child(question.text.clone())).child(
                h_flex().flex_wrap().gap_2().children(question.options.iter().enumerate().map(
                    |(o, option)| {
                        // Options are positions in a request that never
                        // changes, so the position is their identity.
                        let (view, id) = (view.clone(), interaction_id.clone());
                        Button::new(SharedString::from(format!("option-{q}-{o}")))
                            .small()
                            .outline()
                            .label(option.clone())
                            .selected(selected.get(q).copied().flatten() == Some(o))
                            .disabled(!pending || sending)
                            .on_click(move |_, _, cx| {
                                view.update(cx, |view, cx| view.choose(&id, q, o, cx)).ok();
                            })
                    },
                )),
            )
        }))
        .when(pending, |this| {
            let (view, id) = (view.clone(), interaction_id.clone());
            this.child(
                h_flex().child(
                    Button::new("answer")
                        .small()
                        .primary()
                        .label(copy::ANSWER.get(cx))
                        .loading(sending)
                        .disabled(!complete)
                        .on_click(move |_, _, cx| {
                            let answer = InteractionAnswer::Question { answers: answers.clone() };
                            view.update(cx, |view, cx| view.answer(&id, answer, cx)).ok();
                        }),
                ),
            )
        })
        .when_some(outcome.clone(), |this, outcome| this.child(outcome_line(outcome, cx)))
        .into_any_element()
}

fn outcome_line(outcome: SharedString, cx: &App) -> AnyElement {
    div()
        .id("prompt-outcome")
        .test_support()
        .aria_label(outcome.clone())
        .text_size(dp(SUPPORTING_SIZE))
        .text_color(cx.maka().ink_muted)
        .child(outcome)
        .into_any_element()
}

/// What the footer of a turn says, as text: `(visible, full)`. The visible
/// line of a finished turn is only when it started and on which model, as in
/// Maka ("3 days ago · glm-5.3"); a stopped or failed turn leads with that
/// outcome and its reason. The full line, for assistive technology, always
/// leads with the outcome.
fn footer_text(
    locale: Locale,
    footer: &FooterRow,
    now_ms: u64,
    utc_offset: i32,
) -> (SharedString, SharedString) {
    let text = |text: shell_copy::Text| text.in_locale(locale);
    let outcome = match footer.status {
        TurnViewStatus::Running => {
            return (text(copy::TURN_RUNNING).into(), text(copy::TURN_RUNNING).into());
        }
        TurnViewStatus::WaitingForUser => {
            return (text(copy::TURN_WAITING).into(), text(copy::TURN_WAITING).into());
        }
        TurnViewStatus::Completed => text(copy::TURN_FINISHED).to_owned(),
        TurnViewStatus::Failed => match &footer.failure {
            Some(message) => shell_copy::labeled(locale, text(copy::TURN_FAILED), message),
            None => text(copy::TURN_FAILED).to_owned(),
        },
        _ => text(copy::TURN_CANCELLED).to_owned(),
    };
    let started = (footer.started_at > 0)
        .then(|| relative_time(locale, footer.started_at, now_ms, utc_offset));
    let details: Vec<&str> =
        started.as_deref().into_iter().chain(footer.model.as_deref()).collect();
    let join = |parts: &[&str]| parts.join(text(copy::FOOTER_SEPARATOR));
    let full = join(&[&[outcome.as_str()], details.as_slice()].concat());
    let visible = if footer.status == TurnViewStatus::Completed && !details.is_empty() {
        join(&details)
    } else {
        full.clone()
    };
    (visible.into(), full.into())
}

/// The line under a turn (spec §7): supporting 12/20 ink muted, "3 minutes
/// ago · qwen2.5:7b". A running turn leads with Maka's running icon,
/// turning while motion is allowed; the live one then says it is working
/// and for how long, or why and when it retries ([`turn_status`]). A
/// finished turn with a reply ends with a 24 px copy button that shows
/// while the line is hovered, while it has keyboard focus, and for a moment
/// after it copied (its icon then a check and its name "Copied").
fn render_footer(
    footer: FooterRow,
    turn_id: &str,
    spinner_turns: f32,
    now: FooterNow,
    copied: bool,
    view: WeakEntity<ConversationView>,
    window: &Window,
    cx: &App,
) -> AnyElement {
    // A turn waiting on the user says so inside its prompt card, beside the
    // decision; a second line below the card would repeat it.
    if footer.status == TurnViewStatus::WaitingForUser {
        return div().id(SharedString::from(format!("turn-footer:{turn_id}"))).into_any_element();
    }
    let maka = cx.maka();
    let locale = Locale::current(cx);
    let (visible, full) = footer_text(locale, &footer, now.wall_ms, now.utc_offset);
    let running = footer.status == TurnViewStatus::Running;
    let running_line = (running && footer.live).then(|| {
        let FooterNow { wall_ms, retry_remaining_ms, .. } = now;
        turn_status::running_line(locale, &footer, wall_ms, retry_remaining_ms, cx.reduce_motion())
    });
    let name = running_line.as_ref().map_or(full, |line| line.accessible.clone().into());
    let status = h_flex()
        .id("turn-status")
        .test_support()
        .role(Role::Status)
        .aria_label(name)
        .min_w_0()
        .gap(dp(6.))
        .when(running, |this| {
            let mut icon = Icon::new(MakaIcon::StatusRunning)
                .with_size(dp_px(12., window))
                .text_color(maka.primary);
            if !cx.reduce_motion() {
                icon = icon.transform(Transformation::rotate(percentage(spinner_turns)));
            }
            this.child(icon)
        })
        .map(|this| match running_line {
            Some(line) => this.child(render_running_line(line, cx)),
            None => this.child(div().min_w_0().child(visible)),
        });
    let hover_group = SharedString::from(format!("turn-footer:{turn_id}"));
    let copyable = footer.has_reply && !running && footer.status != TurnViewStatus::WaitingForUser;
    let copy_button = copyable.then(|| {
        let label = if copied { copy::REPLY_COPIED.get(cx) } else { copy::COPY_REPLY.get(cx) };
        let turn_id = turn_id.to_owned();
        Button::new("copy-reply")
            .ghost()
            .size(dp(24.))
            .p_0()
            .rounded(dp_px(RADIUS_CONTROL, window))
            .child(
                Icon::new(if copied { MakaIcon::StatusDone } else { MakaIcon::Copy })
                    .with_size(dp_px(14., window))
                    .text_color(maka.ink_muted),
            )
            .accessibility_label(label)
            .tooltip(label)
            .when(!copied, |this| {
                this.opacity(0.)
                    .group_hover(hover_group.clone(), |style| style.opacity(1.))
                    .focus_visible(|style| style.opacity(1.))
            })
            .on_click(move |_, _, cx| {
                view.update(cx, |view, cx| view.copy_reply(&turn_id, cx)).ok();
            })
    });
    h_flex()
        .group(hover_group)
        .h(dp(24.))
        .gap(dp(4.))
        .text_size(dp(SUPPORTING_SIZE))
        .line_height(dp(20.))
        .text_color(maka.ink_muted)
        .child(status)
        .children(copy_button)
        .into_any_element()
}

/// The live running turn's words after its icon: the working phrase, then
/// the clock in tabular figures, so its digits keep their places as it
/// counts. Only the row's accessible name is announced; the parts carry
/// their text as labels for tests.
fn render_running_line(line: RunningLine, cx: &App) -> impl IntoElement {
    h_flex()
        .min_w_0()
        .child(
            div()
                .id("turn-status-label")
                .test_support()
                .aria_label(line.label.clone())
                .min_w_0()
                .truncate()
                .child(line.label),
        )
        .when_some(line.detail, |this, detail| {
            this.child(div().flex_none().child(copy::FOOTER_SEPARATOR.get(cx))).child(
                div()
                    .id("turn-status-detail")
                    .test_support()
                    .aria_label(detail.clone())
                    .flex_none()
                    .font_features(tabular_nums())
                    .child(detail),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn footer(status: TurnViewStatus, failure: Option<&str>) -> FooterRow {
        FooterRow {
            status,
            failure: failure.map(SharedString::from),
            started_at: 1_000_000,
            live: false,
            retry: None,
            model: Some("glm-5.3".into()),
            has_reply: true,
        }
    }

    const EN: Locale = Locale::English;

    #[test]
    fn a_finished_turn_shows_only_its_time_and_model() {
        let now = 1_000_000 + 3 * 86_400_000;
        let (visible, full) = footer_text(EN, &footer(TurnViewStatus::Completed, None), now, 0);
        assert_eq!(visible.as_ref(), "3 days ago · glm-5.3");
        assert_eq!(full.as_ref(), "Finished · 3 days ago · glm-5.3");
    }

    #[test]
    fn a_stopped_or_failed_turn_leads_with_the_outcome_and_reason() {
        let now = 1_000_000 + 90_000;
        let (visible, _) = footer_text(EN, &footer(TurnViewStatus::Cancelled, None), now, 0);
        assert_eq!(visible.as_ref(), "Stopped · 2 minutes ago · glm-5.3");
        let (visible, full) =
            footer_text(EN, &footer(TurnViewStatus::Failed, Some("auth expired")), now, 0);
        assert_eq!(visible.as_ref(), "Failed: auth expired · 2 minutes ago · glm-5.3");
        assert_eq!(visible, full);
    }

    #[test]
    fn unknown_details_are_left_out() {
        let row = FooterRow {
            status: TurnViewStatus::Completed,
            failure: None,
            started_at: 0,
            live: false,
            retry: None,
            model: None,
            has_reply: false,
        };
        let (visible, full) = footer_text(EN, &row, 5_000_000, 0);
        assert_eq!(visible.as_ref(), copy::TURN_FINISHED.en(), "never an empty line");
        assert_eq!(full.as_ref(), copy::TURN_FINISHED.en());
        let running = FooterRow { status: TurnViewStatus::Running, ..row };
        assert_eq!(footer_text(EN, &running, 5_000_000, 0).0.as_ref(), copy::TURN_RUNNING.en());
    }

    #[test]
    fn the_thinking_face_moves_only_while_streaming_with_motion() {
        assert_eq!(drawn_face_secs(true, false, 1.2), 1.2);
        assert_eq!(drawn_face_secs(false, false, 1.2), 0., "at rest once complete");
        assert_eq!(drawn_face_secs(true, true, 1.2), 0., "at rest with reduced motion");
    }

    #[test]
    fn the_footer_speaks_the_locale() {
        let now = 1_000_000 + 3 * 86_400_000;
        let row = footer(TurnViewStatus::Completed, None);
        let zh = Locale::SimplifiedChinese;
        assert_eq!(footer_text(zh, &row, now, 0).0.as_ref(), "3天前 · glm-5.3");
        let failed = footer(TurnViewStatus::Failed, Some("auth expired"));
        assert_eq!(
            footer_text(zh, &failed, now, 0).0.as_ref(),
            "失败：auth expired · 3天前 · glm-5.3"
        );
    }
}
