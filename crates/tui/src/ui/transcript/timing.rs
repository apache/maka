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

//! Elapsed wall time from recorded turn boundaries, not time spent viewing a page.
use super::*;

#[derive(Clone, Default)]
pub struct Timing {
    pub turn: String,
    pub active: bool,
    pub start: Option<i64>,
    pub end: Option<(i64, Outcome)>,
}

#[derive(Clone, Copy)]
pub enum Outcome {
    Completed,
    Failed,
    Aborted,
}

impl Timing {
    fn label(&self, ascii: bool, now: i64) -> Option<String> {
        let start = self.start?;
        let end = self.end.map_or(now, |(at, _)| at);
        if end < start {
            return None;
        }
        let seconds = end.saturating_sub(start) as u64 / 1000;
        let time = if seconds < 60 {
            format!("{seconds}s")
        } else if seconds < 3600 {
            format!("{}m {:02}s", seconds / 60, seconds % 60)
        } else {
            format!(
                "{}h {:02}m {:02}s",
                seconds / 3600,
                seconds / 60 % 60,
                seconds % 60
            )
        };
        let mark = match (self.end.map(|(_, outcome)| outcome), ascii) {
            (None, false) => "·",
            (None, true) => ".",
            (Some(Outcome::Completed), false) => "✓",
            (Some(Outcome::Completed), true) => "+",
            (Some(Outcome::Failed), _) => "!",
            (Some(Outcome::Aborted), false) => "■",
            (Some(Outcome::Aborted), true) => "-",
        };
        Some(format!("{mark} {time}"))
    }
}

impl Transcript {
    pub(super) fn sync_timings(&mut self, timings: impl IntoIterator<Item = Timing>) {
        self.timings = timings
            .into_iter()
            .map(|timing| (timing.turn.clone(), timing))
            .collect();
        // A timing footer is presentation only: not a tool, fold target or search result.
        let mut order = std::mem::take(&mut self.order);
        let turns: Vec<_> = self
            .timings
            .iter()
            .filter(|(_, timing)| timing.start.is_some() && (timing.end.is_some() || timing.active))
            .map(|(turn, _)| turn.clone())
            .collect();
        for turn in turns {
            let Some(index) = order.iter().rposition(|key| key.turn == turn) else {
                continue;
            };
            let key = MessageKey {
                turn,
                message: String::new(),
                part: Part::Timing,
            };
            self.upsert(key.clone(), Revision::Live(0), Kind::Timing, || {
                String::new().into()
            });
            order.insert(index + 1, key);
        }
        self.order = order;
    }

    pub(super) fn update_timings(&mut self, ascii: bool, now: i64) {
        for key in self.order.iter().filter(|key| key.part() == Part::Timing) {
            let block = self.blocks.get_mut(key).unwrap();
            let text = self
                .timings
                .get(&key.turn)
                .and_then(|timing| timing.label(ascii, now))
                .unwrap_or_default();
            if block.text != text {
                block.text = text;
                block.layout = None;
            }
        }
    }

    pub(super) fn timing_color(&self, turn: &str) -> Color {
        match self.timings.get(turn).and_then(|timing| timing.end) {
            None => self.colors.accent,
            Some((_, Outcome::Failed)) => self.colors.error,
            Some((_, Outcome::Aborted)) => self.colors.warning,
            Some((_, Outcome::Completed)) => self.colors.subtle,
        }
    }

    pub fn timing_visible(&self) -> bool {
        (self.starts.at(self.top)..self.starts.len())
            .take_while(|index| self.starts.start(*index) < self.top + self.height)
            .any(|index| {
                let key = &self.order[index];
                key.part() == Part::Timing
                    && self
                        .timings
                        .get(&key.turn)
                        .is_some_and(|timing| timing.active && timing.end.is_none())
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Locale, LocalePreference};
    use serde_json::json;

    #[test]
    fn recorded_boundaries_distinguish_live_success_failure_and_abort_without_resetting_on_tail_pages()
     {
        let mut view = Transcript {
            active_turn: Some("t".into()),
            ..Default::default()
        };
        let i18n = I18n::new(LocalePreference::Explicit(Locale::En), Locale::En);
        let start = json!({"id":"s","turnId":"t","type":"turn_state","status":"running","ts":1000});
        let answer = json!({"id":"a","turnId":"t","type":"assistant","text":"Answer"});
        let mut rows = BTreeMap::from([(1, start.clone()), (2, answer)]);
        view.sync(&rows, &[], 0, &i18n, false);
        view.update_timings(false, 13000);
        let key = view.order.last().unwrap().clone();
        assert_eq!(view.blocks[&key].text, "· 12s");
        assert!(!view.can_toggle(&key));
        rows.remove(&1);
        view.sync(&rows, &[], 1, &i18n, false);
        view.update_timings(false, 69000);
        assert_eq!(view.blocks[&key].text, "· 1m 08s");
        for (status, mark) in [("completed", "✓"), ("failed", "!"), ("aborted", "■")] {
            rows.insert(
                3,
                json!({"id":"e","turnId":"t","type":"turn_state","status":status,"ts":69000}),
            );
            view.active_turn = None;
            view.sync(&rows, &[], 2, &i18n, false);
            view.update_timings(false, 999999);
            assert_eq!(view.blocks[&key].text, format!("{mark} 1m 08s"));
            assert!(!view.timing_visible());
        }
        let mut restored = Transcript::default();
        restored.sync(&rows, &[], 0, &i18n, false);
        assert!(
            !restored.order.iter().any(|key| key.part() == Part::Timing),
            "missing start is unknown, not zero"
        );
        rows.insert(1, start);
        restored.sync(&rows, &[], 0, &i18n, false);
        restored.update_timings(false, 999999);
        assert_eq!(restored.blocks[&key].text, "■ 1m 08s");
        let future = Timing {
            start: Some(2000),
            end: None,
            ..Default::default()
        };
        assert!(future.label(false, 1000).is_none());
    }
}
