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

use std::{future::Future, pin::pin, task::Poll, time::Duration};
use tokio::{sync::watch, time::Instant};

/// Charge synchronous VM polls, not the intervals awaiting Host tools. The Host
/// watches the same clock so it can interrupt a poll that never returns.
#[derive(Clone)]
pub(crate) struct ExecutionBudget(watch::Sender<Clock>);

struct Clock {
    remaining: Duration,
    started: Option<Instant>,
}

impl ExecutionBudget {
    pub(crate) fn new(remaining: Duration) -> Self {
        Self(
            watch::channel(Clock {
                remaining,
                started: None,
            })
            .0,
        )
    }

    pub(crate) async fn run<F: Future>(&self, future: F) -> Result<F::Output, ()> {
        let mut future = pin!(future);
        std::future::poll_fn(|cx| {
            if self.0.borrow().remaining.is_zero() {
                return Poll::Ready(Err(()));
            }
            self.0
                .send_modify(|clock| clock.started = Some(Instant::now()));
            let result = future.as_mut().poll(cx);
            let mut exhausted = false;
            self.0.send_modify(|clock| {
                let elapsed = clock.started.take().expect("VM poll started").elapsed();
                clock.remaining = clock.remaining.saturating_sub(elapsed);
                exhausted = clock.remaining.is_zero();
            });
            if exhausted {
                Poll::Ready(Err(()))
            } else {
                result.map(Ok)
            }
        })
        .await
    }

    pub(crate) async fn exhausted(&self) {
        let mut changes = self.0.subscribe();
        loop {
            let deadline = {
                let clock = changes.borrow_and_update();
                let deadline = clock.started.map(|start| start + clock.remaining);
                // Decide while holding the read guard: a stale running snapshot
                // must not charge time after the worker has paused the clock.
                if clock.remaining.is_zero() || deadline.is_some_and(|end| Instant::now() >= end) {
                    return;
                }
                deadline
            };
            if let Some(deadline) = deadline {
                tokio::select! {
                    _ = changes.changed() => {},
                    _ = tokio::time::sleep_until(deadline) => {},
                }
            } else {
                // Self owns a sender for the whole wait.
                changes.changed().await.expect("execution clock is alive");
            }
        }
    }
}
