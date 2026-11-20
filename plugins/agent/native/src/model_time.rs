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

use std::{collections::BTreeSet, time::Instant};

/// Paired tool intervals share one clock, including when multiple tools run concurrently.
#[derive(Default)]
pub(crate) struct ToolIntervals {
    open: BTreeSet<String>,
    since: u64,
    waited: u64,
    incomplete: bool,
}

impl ToolIntervals {
    pub(crate) fn start(&mut self, id: &str, at: Option<u64>) {
        if self.open.is_empty() {
            match at {
                Some(at) => self.since = at,
                None => self.incomplete = true,
            }
        }
        self.open.insert(id.to_owned());
    }

    pub(crate) fn end(&mut self, id: &str, at: Option<u64>) {
        if !self.open.remove(id) {
            self.incomplete = true;
        } else if self.open.is_empty() {
            match at
                .and_then(|end| end.checked_sub(self.since))
                .and_then(|ms| self.waited.checked_add(ms))
            {
                Some(total) => self.waited = total,
                None => self.incomplete = true,
            }
        }
    }

    pub(crate) fn unmeasured_tool(&mut self) {
        self.incomplete = true;
    }

    pub(crate) fn model_ms(&self, total: u64) -> Option<u64> {
        if self.incomplete || !self.open.is_empty() {
            return None;
        }
        total.checked_sub(self.waited).filter(|ms| *ms > 0)
    }
}

pub(crate) struct ModelTime {
    start: Instant,
    waits: ToolIntervals,
}

impl ModelTime {
    pub(crate) fn new() -> Self {
        Self {
            start: Instant::now(),
            waits: ToolIntervals::default(),
        }
    }
    fn now(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
    pub(crate) fn tool_started(&mut self, id: &str) {
        self.waits.start(id, Some(self.now()));
    }
    pub(crate) fn tool_finished(&mut self, id: &str) {
        self.waits.end(id, Some(self.now()));
    }
    pub(crate) fn unmeasured_tool(&mut self) {
        self.waits.unmeasured_tool();
    }
    pub(crate) fn millis(&self) -> Option<u64> {
        self.waits.model_ms(self.now())
    }
}

#[cfg(test)]
mod tests {
    use super::ToolIntervals;

    #[test]
    fn overlapping_tools_and_long_waits_do_not_change_throughput() {
        for delay in [100, 300_000] {
            let mut tools = ToolIntervals::default();
            tools.start("a", Some(10));
            tools.start("b", Some(20));
            tools.end("a", Some(40));
            assert_eq!(tools.model_ms(45), None);
            tools.end("b", Some(10 + delay));
            assert_eq!(tools.model_ms(50 + delay), Some(50));
        }
        let mut unmatched = ToolIntervals::default();
        unmatched.end("unseen", Some(20));
        assert_eq!(unmatched.model_ms(30), None);
    }
}
