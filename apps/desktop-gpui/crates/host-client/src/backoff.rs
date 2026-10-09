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

//! Reconnect and liveness timing.
//!
//! Sources in `packages/runtime-host/src/client/`:
//! - `reconnect-lifecycle.ts`: `DEFAULT_BACKOFF_MIN_MS`, `DEFAULT_BACKOFF_MAX_MS`,
//!   `DEFAULT_STABLE_CONNECTION_MS`, `DEFAULT_UNSTABLE_MAX_MS`, `reconnectDelayMs`;
//! - `connection.ts`: `DEFAULT_LIVENESS_INTERVAL_MS`, `DEFAULT_LIVENESS_TIMEOUT_MS`.

use std::time::Duration;

/// Timing for a supervised connection. [`Default`] matches the TS client.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ReconnectPolicy {
    /// Delay before the second attempt of a failure streak. The first attempt
    /// after a connection is lost runs immediately.
    pub backoff_min: Duration,
    /// Ceiling while the streak is short.
    pub backoff_max: Duration,
    /// A connection that lived at least this long resets the streak.
    pub stable_connection: Duration,
    /// Ceiling once the doubling delay has passed twice `backoff_max`: a Host
    /// that keeps dying is retried at most this often.
    pub unstable_max: Duration,
    /// Pause between one `host.status` probe finishing and the next starting.
    pub liveness_interval: Duration,
    /// A probe that has not answered within this long ends the connection.
    /// Only the probe's own response counts: other frames arriving meanwhile
    /// do not prove that requests still round-trip.
    pub liveness_timeout: Duration,
    /// Budget for opening the socket and completing the handshake.
    pub connect_timeout: Duration,
    /// Budget for a Host that is still starting to report `ready`.
    pub ready_timeout: Duration,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            backoff_min: Duration::from_millis(100),
            backoff_max: Duration::from_secs(5),
            stable_connection: Duration::from_secs(10),
            unstable_max: Duration::from_secs(60),
            liveness_interval: Duration::from_secs(2),
            liveness_timeout: Duration::from_secs(8),
            connect_timeout: Duration::from_secs(10),
            ready_timeout: Duration::from_secs(30),
        }
    }
}

impl ReconnectPolicy {
    /// Replaces the backoff bounds.
    pub fn with_backoff(mut self, min: Duration, max: Duration, unstable_max: Duration) -> Self {
        self.backoff_min = min;
        self.backoff_max = max.max(min);
        self.unstable_max = unstable_max.max(self.backoff_max);
        self
    }

    /// Replaces the stable-connection threshold.
    pub fn with_stable_connection(mut self, stable_connection: Duration) -> Self {
        self.stable_connection = stable_connection;
        self
    }

    /// Replaces the liveness probe interval and timeout.
    pub fn with_liveness(mut self, interval: Duration, timeout: Duration) -> Self {
        self.liveness_interval = interval;
        self.liveness_timeout = timeout;
        self
    }

    /// Replaces the connect and ready budgets.
    pub fn with_timeouts(mut self, connect: Duration, ready: Duration) -> Self {
        self.connect_timeout = connect;
        self.ready_timeout = ready;
        self
    }

    /// The wait before the attempt that follows `failures` consecutive
    /// failures, `reconnectDelayMs(failures - 1, …)`. `sample` is a uniform
    /// random value in `[0, 1]` for the ±20% jitter.
    pub fn reconnect_delay(&self, failures: u32, sample: f64) -> Duration {
        let attempt = failures.saturating_sub(1);
        let min = self.backoff_min.as_secs_f64() * 1000.0;
        if attempt == 0 || min == 0.0 {
            return Duration::ZERO;
        }
        let max = self.backoff_max.as_secs_f64() * 1000.0;
        let unstable_max = self.unstable_max.as_secs_f64() * 1000.0;
        let exponential = min * 2f64.powi((attempt - 1).min(30) as i32);
        let ceiling = if exponential >= 2.0 * max { unstable_max } else { max };
        let bounded = if sample.is_finite() { sample.clamp(0.0, 1.0) } else { 0.5 };
        let delay_ms = (exponential * (0.8 + bounded * 0.4)).round().max(1.0).min(ceiling);
        Duration::from_secs_f64(delay_ms / 1000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn defaults_match_the_ts_client() {
        let policy = ReconnectPolicy::default();
        assert_eq!(policy.backoff_min, ms(100));
        assert_eq!(policy.backoff_max, ms(5_000));
        assert_eq!(policy.stable_connection, ms(10_000));
        assert_eq!(policy.unstable_max, ms(60_000));
        assert_eq!(policy.liveness_interval, ms(2_000));
        assert_eq!(policy.liveness_timeout, ms(8_000));
    }

    #[test]
    fn the_first_attempt_after_a_loss_is_immediate() {
        let policy = ReconnectPolicy::default();
        assert_eq!(policy.reconnect_delay(0, 0.5), Duration::ZERO);
        assert_eq!(policy.reconnect_delay(1, 0.5), Duration::ZERO);
    }

    #[test]
    fn delays_double_without_jitter_at_the_midpoint() {
        let policy = ReconnectPolicy::default();
        let delays: Vec<_> =
            (2..=8).map(|failures| policy.reconnect_delay(failures, 0.5)).collect();
        assert_eq!(delays, [ms(100), ms(200), ms(400), ms(800), ms(1_600), ms(3_200), ms(5_000)]);
    }

    #[test]
    fn a_saturated_streak_escalates_toward_the_unstable_ceiling() {
        let policy = ReconnectPolicy::default();
        // 100 ms · 2^7 = 12.8 s ≥ 2 × 5 s, so the 60 s ceiling applies.
        assert_eq!(policy.reconnect_delay(9, 0.5), ms(12_800));
        assert_eq!(policy.reconnect_delay(10, 0.5), ms(25_600));
        assert_eq!(policy.reconnect_delay(11, 0.5), ms(51_200));
        assert_eq!(policy.reconnect_delay(12, 0.5), ms(60_000));
        assert_eq!(policy.reconnect_delay(500, 0.5), ms(60_000));
    }

    #[test]
    fn jitter_spans_plus_minus_twenty_percent_and_tolerates_bad_samples() {
        let policy = ReconnectPolicy::default();
        assert_eq!(policy.reconnect_delay(4, 0.0), ms(320));
        assert_eq!(policy.reconnect_delay(4, 1.0), ms(480));
        assert_eq!(policy.reconnect_delay(4, 7.0), ms(480));
        assert_eq!(policy.reconnect_delay(4, f64::NAN), ms(400));
    }

    #[test]
    fn a_zero_minimum_disables_backoff() {
        let policy = ReconnectPolicy::default().with_backoff(ms(0), ms(0), ms(0));
        assert_eq!(policy.reconnect_delay(20, 0.5), Duration::ZERO);
    }
}
