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

use std::time::{Duration, Instant};
use tokio::sync::watch;

#[derive(Clone)]
pub(crate) struct TimeoutClock(watch::Sender<State>);

#[derive(Default)]
struct State {
    suspensions: usize,
    executions: usize,
    excluded: Duration,
    paused_since: Option<Instant>,
}

impl State {
    fn excluded_at(&self, now: Instant) -> Duration {
        self.excluded
            + self
                .paused_since
                .map(|start| now.duration_since(start))
                .unwrap_or_default()
    }
}

impl Default for TimeoutClock {
    fn default() -> Self {
        Self(watch::channel(State::default()).0)
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Suspension,
    Execution,
}

/// Trusted Host/interpreter scope. Dropping it restores the prior clock state;
/// nested or concurrent scopes never refill the evaluation's remaining budget.
#[must_use = "the timeout scope ends when its guard is dropped"]
pub struct CellTimeoutGuard {
    clock: TimeoutClock,
    kind: Kind,
}

/// One evaluation's immutable allowance and start point.
#[derive(Clone)]
pub struct CellTimeoutBudget {
    clock: TimeoutClock,
    budget: Duration,
    started: Instant,
    excluded_before: Duration,
}

impl Drop for CellTimeoutGuard {
    fn drop(&mut self) {
        self.clock.change(self.kind, false);
    }
}

impl TimeoutClock {
    pub(crate) fn suspend(&self) -> CellTimeoutGuard {
        self.enter(Kind::Suspension)
    }

    pub(crate) fn execute(&self) -> CellTimeoutGuard {
        self.enter(Kind::Execution)
    }

    fn enter(&self, kind: Kind) -> CellTimeoutGuard {
        self.change(kind, true);
        CellTimeoutGuard {
            clock: self.clone(),
            kind,
        }
    }

    fn change(&self, kind: Kind, entering: bool) {
        self.0.send_modify(|state| {
            let now = Instant::now();
            if let Some(start) = state.paused_since.take() {
                state.excluded += now.duration_since(start);
            }
            let count = match kind {
                Kind::Suspension => &mut state.suspensions,
                Kind::Execution => &mut state.executions,
            };
            if entering {
                *count += 1;
            } else {
                *count -= 1;
            }
            if state.suspensions != 0 && state.executions == 0 {
                state.paused_since = Some(now);
            }
        });
    }

    pub(crate) fn budget(&self, budget: Duration) -> CellTimeoutBudget {
        let (started, excluded_before) = {
            let state = self.0.borrow();
            let now = Instant::now();
            (now, state.excluded_at(now))
        };
        CellTimeoutBudget {
            clock: self.clone(),
            budget,
            started,
            excluded_before,
        }
    }
}

impl CellTimeoutBudget {
    fn remaining(&self, state: &State) -> Option<Duration> {
        let now = Instant::now();
        let excluded = state.excluded_at(now).saturating_sub(self.excluded_before);
        let charged = now.duration_since(self.started).saturating_sub(excluded);
        let remaining = self.budget.saturating_sub(charged);
        if remaining.is_zero() || state.paused_since.is_none() {
            Some(remaining)
        } else {
            None
        }
    }

    /// Check at settlement as well: a delayed watchdog cannot admit an
    /// over-budget result before its timer task gets scheduled.
    pub fn is_expired(&self) -> bool {
        self.remaining(&self.clock.0.borrow()) == Some(Duration::ZERO)
    }

    pub async fn expired(&self) {
        let mut changes = self.clock.0.subscribe();
        loop {
            let remaining = self.remaining(&changes.borrow_and_update());
            if let Some(remaining) = remaining {
                if remaining.is_zero() {
                    return;
                }
                tokio::select! {
                    _ = changes.changed() => {},
                    _ = tokio::time::sleep(remaining) => {},
                }
            } else {
                changes.changed().await.expect("timeout clock is alive");
            }
        }
    }
}
