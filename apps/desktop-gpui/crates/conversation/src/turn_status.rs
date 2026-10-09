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

//! What the live running turn's status line says: Maka Desktop's
//! `TurnRunningStatus` and the running arm of `TurnStatusRow`
//! (packages/ui/src/chat-turn.tsx).
//!
//! A working phrase that changes every [`PHRASE_INTERVAL`] says the turn is
//! alive, and the clock after it counts whole seconds from the turn's first
//! row, the user's message, so it measures the wait from pressing Send. The
//! line's accessible name stays "Working…" while the phrase and the clock
//! move, so nothing is announced each second. With motion reduced the
//! phrase stays on the first one; the clock still counts, since elapsed time
//! is information rather than motion.
//!
//! While the Runtime retries a provider request the line says so instead:
//! the reason, then the countdown to the attempt or the attempt under way.
//! Desktop splits that between the status row (`providerRetryWaiting`,
//! `providerRetryStarted`) and a banner after the answer
//! (`ModelProviderRetryIndicator`); this line already sits after the
//! answer, so it carries both. Its accessible name is the reason and the
//! waiting or started words, without the countdown, as Desktop's banner
//! names itself.
//!
//! Desktop's one concrete activity label names the Computer Use action a
//! turn is driving (`computerRunningLabel`). Computer Use is a capability
//! only Desktop offers its Host, so here the phrase always shows.

use std::time::{Duration, Instant};

use host_protocol::{ProviderRetryPhase, ProviderRetryReason, TurnProviderRetry};
use shared::copy::Locale;
use shared::copy::conversation as copy;

use crate::rows::FooterRow;

/// How long each working phrase shows (Desktop's
/// `WORKING_PHRASE_INTERVAL_MS`).
pub(crate) const PHRASE_INTERVAL: Duration = Duration::from_secs(20);

/// Below this a turn's start is a placeholder rather than a time; the phrase
/// then stands alone. 2001-09-09 in milliseconds (Desktop's
/// `MIN_PLAUSIBLE_TURN_TS`).
const MIN_PLAUSIBLE_START_MS: u64 = 1_000_000_000_000;

/// The live running turn's status line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunningLine {
    /// What the turn is doing: a working phrase, or why it retries.
    pub(crate) label: String,
    /// After the label: the elapsed clock when the turn's start is known,
    /// or where the retry is.
    pub(crate) detail: Option<String>,
    /// The line's accessible name, which does not change as the clock or
    /// the countdown ticks.
    pub(crate) accessible: String,
}

/// The status line of a live running turn at `now_ms` (wall-clock
/// milliseconds since the Unix epoch). `retry_remaining_ms` is how long a
/// scheduled retry still waits, from the turn's [`RetryCountdown`].
pub(crate) fn running_line(
    locale: Locale,
    footer: &FooterRow,
    now_ms: u64,
    retry_remaining_ms: Option<u64>,
    reduce_motion: bool,
) -> RunningLine {
    if let Some(line) =
        footer.retry.as_ref().and_then(|retry| retry_line(locale, retry, retry_remaining_ms))
    {
        return line;
    }
    let elapsed = elapsed_ms(footer, now_ms);
    let step =
        if reduce_motion { 0 } else { elapsed.unwrap_or(0) / PHRASE_INTERVAL.as_millis() as u64 };
    RunningLine {
        label: copy::working_phrase(locale, step).to_owned(),
        detail: elapsed.map(|elapsed| copy::turn_elapsed(locale, elapsed)),
        accessible: copy::TURN_RUNNING.in_locale(locale).to_owned(),
    }
}

/// The line while the Runtime retries a provider request; `None` for a
/// phase this client does not know, which leaves the working line.
fn retry_line(
    locale: Locale,
    retry: &TurnProviderRetry,
    remaining_ms: Option<u64>,
) -> Option<RunningLine> {
    let (attempt, max) = (retry.attempt, retry.max_attempts);
    let (detail, state) = match retry.phase {
        ProviderRetryPhase::Scheduled => {
            let remaining = remaining_ms.or(retry.delay_ms).unwrap_or(0);
            let seconds = remaining.div_ceil(1000).max(1);
            (
                copy::retry_scheduled(locale, seconds, attempt, max),
                copy::retry_waiting(locale, attempt, max),
            )
        }
        ProviderRetryPhase::Started => {
            let started = copy::retry_started(locale, attempt, max);
            (started.clone(), started)
        }
        _ => return None,
    };
    let reason = retry_reason(&retry.reason).in_locale(locale);
    let separator = copy::FOOTER_SEPARATOR.in_locale(locale);
    Some(RunningLine {
        label: reason.to_owned(),
        detail: Some(detail),
        accessible: format!("{reason}{separator}{state}"),
    })
}

/// Desktop's `providerRetryReason`; a reason this client does not know
/// reads as a failed request.
fn retry_reason(reason: &ProviderRetryReason) -> shared::copy::Text {
    match reason {
        ProviderRetryReason::StreamTruncated => copy::RETRY_REASON_STREAM_TRUNCATED,
        ProviderRetryReason::Network => copy::RETRY_REASON_NETWORK,
        ProviderRetryReason::ProviderCapacity => copy::RETRY_REASON_PROVIDER_CAPACITY,
        ProviderRetryReason::ProviderUnavailable => copy::RETRY_REASON_PROVIDER_UNAVAILABLE,
        ProviderRetryReason::RateLimit => copy::RETRY_REASON_RATE_LIMIT,
        ProviderRetryReason::Timeout => copy::RETRY_REASON_TIMEOUT,
        _ => copy::RETRY_REASON_UNKNOWN,
    }
}

/// How long until the line of a live running turn next changes: when its
/// clock reaches the next whole second, or its retry countdown the next
/// whole second down. `None` when nothing on the line moves with time: no
/// known start, a retry under way, or a countdown that has run out.
pub(crate) fn until_next_tick(
    footer: &FooterRow,
    now_ms: u64,
    retry_remaining_ms: Option<u64>,
) -> Option<Duration> {
    match footer.retry.as_ref().map(|retry| &retry.phase) {
        Some(ProviderRetryPhase::Scheduled) => {
            let remaining = retry_remaining_ms.filter(|remaining| *remaining > 0)?;
            Some(Duration::from_millis(match remaining % 1000 {
                0 => 1000,
                rest => rest,
            }))
        }
        Some(ProviderRetryPhase::Started) => None,
        _ => {
            let elapsed = elapsed_ms(footer, now_ms)?;
            Some(Duration::from_millis(1000 - elapsed % 1000))
        }
    }
}

/// A scheduled retry's countdown in this machine's clock: the wait the
/// Runtime still had when the retry was reported, counted down from then,
/// as Desktop counts it (`LiveProviderRetry.receivedAtMs` with the
/// `remainingMs` its Host adapter computes). A Host clock that differs from
/// this machine's skews only where the countdown starts.
#[derive(Debug, Clone)]
pub(crate) struct RetryCountdown {
    turn_id: String,
    retry: TurnProviderRetry,
    received: Instant,
    remaining_ms: u64,
}

impl RetryCountdown {
    /// Counts down `retry` of turn `turn_id`, reported at `received`, when
    /// the wall clock read `now_ms`.
    pub(crate) fn new(
        turn_id: &str,
        retry: &TurnProviderRetry,
        received: Instant,
        now_ms: u64,
    ) -> Self {
        let waited = retry.ts.map_or(0, |ts| now_ms.saturating_sub(ts));
        Self {
            turn_id: turn_id.to_owned(),
            retry: retry.clone(),
            received,
            remaining_ms: retry.delay_ms.unwrap_or(0).saturating_sub(waited),
        }
    }

    /// Whether this is the countdown of `retry` of turn `turn_id`.
    pub(crate) fn counts(&self, turn_id: &str, retry: &TurnProviderRetry) -> bool {
        self.turn_id == turn_id && &self.retry == retry
    }

    /// How long the Runtime still waits at `now`.
    pub(crate) fn remaining_ms(&self, now: Instant) -> u64 {
        let counted = now.saturating_duration_since(self.received).as_millis() as u64;
        self.remaining_ms.saturating_sub(counted)
    }
}

/// Milliseconds since the turn started, when its start is a real time. A
/// start ahead of `now_ms` (the Host's clock ahead of this machine's) reads
/// as zero.
fn elapsed_ms(footer: &FooterRow, now_ms: u64) -> Option<u64> {
    (footer.started_at > MIN_PLAUSIBLE_START_MS).then(|| now_ms.saturating_sub(footer.started_at))
}

#[cfg(test)]
mod tests {
    use transcript_model::TurnViewStatus;

    use super::*;

    const EN: Locale = Locale::English;
    const START: u64 = 1_790_000_000_000;

    fn footer(started_at: u64) -> FooterRow {
        FooterRow {
            status: TurnViewStatus::Running,
            failure: None,
            started_at,
            live: true,
            retry: None,
            model: None,
            has_reply: false,
        }
    }

    fn retrying(retry: serde_json::Value) -> FooterRow {
        let retry = serde_json::from_value(retry).expect("retry");
        FooterRow { retry: Some(retry), ..footer(START) }
    }

    fn scheduled() -> FooterRow {
        retrying(serde_json::json!({"phase": "scheduled", "attempt": 2, "maxAttempts": 5,
                                    "delayMs": 4000, "reason": "rate_limit", "ts": START}))
    }

    #[test]
    fn the_phrase_changes_every_interval_and_the_name_never_does() {
        let line = running_line(EN, &footer(START), START, None, false);
        assert_eq!(line.label, "Pondering…");
        assert_eq!(line.detail.as_deref(), Some("0s"));
        assert_eq!(line.accessible, copy::TURN_RUNNING.en());
        let line = running_line(EN, &footer(START), START + 19_999, None, false);
        assert_eq!(line.label, "Pondering…");
        let line = running_line(EN, &footer(START), START + 20_000, None, false);
        assert_eq!(line.label, "Tinkering…");
        assert_eq!(line.detail.as_deref(), Some("20s"));
        assert_eq!(line.accessible, copy::TURN_RUNNING.en());
    }

    #[test]
    fn reduced_motion_keeps_the_first_phrase_and_the_clock() {
        let line = running_line(EN, &footer(START), START + 65_000, None, true);
        assert_eq!(line.label, "Pondering…");
        assert_eq!(line.detail.as_deref(), Some("1m 5s"));
    }

    #[test]
    fn without_a_real_start_the_phrase_stands_alone() {
        let line = running_line(EN, &footer(10), START, None, false);
        assert_eq!((line.label.as_str(), line.detail), ("Pondering…", None));
        assert_eq!(until_next_tick(&footer(10), START, None), None, "nothing to tick");
    }

    #[test]
    fn a_start_ahead_of_this_clock_reads_as_zero() {
        let line = running_line(EN, &footer(START + 5_000), START, None, false);
        assert_eq!(line.detail.as_deref(), Some("0s"));
    }

    #[test]
    fn the_next_tick_lands_on_the_next_whole_second() {
        let next = |elapsed| until_next_tick(&footer(START), START + elapsed, None);
        assert_eq!(next(0), Some(Duration::from_secs(1)));
        assert_eq!(next(250), Some(Duration::from_millis(750)));
        assert_eq!(next(59_999), Some(Duration::from_millis(1)));
    }

    #[test]
    fn a_scheduled_retry_counts_down_under_a_name_that_does_not() {
        let line = running_line(EN, &scheduled(), START + 90_000, Some(3_500), false);
        assert_eq!(line.label, "Model rate limit reached");
        assert_eq!(line.detail.as_deref(), Some("Retrying in 4s (2/5)"));
        assert_eq!(line.accessible, "Model rate limit reached · Waiting to retry (2/5)");
        let line = running_line(EN, &scheduled(), START, Some(0), false);
        assert_eq!(line.detail.as_deref(), Some("Retrying in 1s (2/5)"), "never zero");
        let line = running_line(EN, &scheduled(), START, None, false);
        assert_eq!(line.detail.as_deref(), Some("Retrying in 4s (2/5)"), "the whole wait");

        let next = |remaining| until_next_tick(&scheduled(), START, Some(remaining));
        assert_eq!(next(3_500), Some(Duration::from_millis(500)));
        assert_eq!(next(3_000), Some(Duration::from_secs(1)));
        assert_eq!(next(0), None, "nothing moves once the wait is over");
    }

    #[test]
    fn a_retry_under_way_names_its_attempt_and_reason_and_never_ticks() {
        let started = retrying(serde_json::json!({"phase": "started", "attempt": 3,
                                                  "maxAttempts": 5, "reason": "network"}));
        let line = running_line(Locale::SimplifiedChinese, &started, START, None, false);
        assert_eq!(line.label, "网络中断");
        assert_eq!(line.detail.as_deref(), Some("正在重试（3/5）"));
        assert_eq!(line.accessible, "网络中断 · 正在重试（3/5）");
        assert_eq!(until_next_tick(&started, START + 2_500, None), None);
    }

    #[test]
    fn an_unknown_retry_phase_leaves_the_working_line() {
        let future = retrying(serde_json::json!({"phase": "paused", "attempt": 2,
                                                 "maxAttempts": 5, "reason": "network"}));
        let line = running_line(EN, &future, START + 1_000, None, false);
        assert_eq!((line.label.as_str(), line.detail.as_deref()), ("Pondering…", Some("1s")));
        assert_eq!(until_next_tick(&future, START + 1_000, None), Some(Duration::from_secs(1)));
    }

    #[test]
    fn a_countdown_starts_from_what_was_left_when_it_was_reported() {
        let FooterRow { retry: Some(retry), .. } = scheduled() else { unreachable!() };
        let received = Instant::now();
        // Reported 1.5 s into the 4 s wait.
        let countdown = RetryCountdown::new("t", &retry, received, START + 1_500);
        assert!(countdown.counts("t", &retry));
        assert!(!countdown.counts("t2", &retry));
        assert_eq!(countdown.remaining_ms(received), 2_500);
        assert_eq!(countdown.remaining_ms(received + Duration::from_secs(1)), 1_500);
        assert_eq!(countdown.remaining_ms(received + Duration::from_secs(9)), 0);
    }
}
