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

//! Visible widgets request their next frame; offscreen content owns no timer.
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub enum Loop {
    Familiar,
    Spring,
    OrbitSmall,
}

const FAMILIAR: &[(&str, u64)] = &[
    ("o_o", 900),
    (">_>", 350),
    ("o_o", 650),
    ("o_-", 120),
    ("o_o", 700),
    ("<_<", 350),
    ("o_o", 700),
    ("-_-", 100),
];

const SPRING: &[(&str, u64)] = &[
    ("⣀⡀ ", 170),
    ("⣤  ", 65),
    ("⠰⠆ ", 90),
    (" ⠛ ", 105),
    (" ⠰⠆", 85),
    ("  ⣤", 65),
    (" ⢀⣀", 170),
    ("  ⣤", 65),
    (" ⠰⠆", 90),
    (" ⠛ ", 105),
    ("⠰⠆ ", 85),
    ("⣤  ", 65),
];
const ORBIT_SMALL: &[(&str, u64)] = &[("⢁", 180), ("⡈", 180), ("⠔", 180), ("⠢", 180)];
const ORBIT_SMALL_ASCII: &[(&str, u64)] = &[("/", 180), ("-", 180), ("\\", 180), ("|", 180)];
const SPRING_ASCII: &[(&str, u64)] = &[("o  ", 150), (" o ", 150), ("  o", 150), (" o ", 150)];

pub struct Motion {
    origin: Instant,
    now: Instant,
    enabled: bool,
    next: Option<Instant>,
}
impl Default for Motion {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            origin: now,
            now,
            enabled: false,
            next: None,
        }
    }
}
impl Motion {
    pub fn begin(&mut self, now: Instant, enabled: bool) {
        self.now = now;
        self.enabled = enabled;
        self.next = None;
    }
    fn elapsed(&self) -> u128 {
        self.now.saturating_duration_since(self.origin).as_millis()
    }
    fn request(&mut self, ms: u64) {
        if self.enabled {
            let at = self.now + Duration::from_millis(ms.max(1));
            self.next = Some(self.next.map_or(at, |old| old.min(at)));
        }
    }
    pub fn wait(&self, now: Instant) -> Option<Duration> {
        self.next.map(|at| at.saturating_duration_since(now))
    }
    /// A changing value is not decorative motion; reduced motion still updates it.
    pub fn wake_after(&mut self, duration: Duration) {
        let at = self.now + duration;
        self.next = Some(self.next.map_or(at, |old| old.min(at)));
    }
    pub fn frame(&mut self, kind: Loop, ascii: bool) -> &'static str {
        let frames = match (kind, ascii) {
            (Loop::Familiar, _) => FAMILIAR,
            (Loop::Spring, false) => SPRING,
            (Loop::Spring, true) => SPRING_ASCII,
            (Loop::OrbitSmall, false) => ORBIT_SMALL,
            (Loop::OrbitSmall, true) => ORBIT_SMALL_ASCII,
        };
        if !self.enabled {
            return frames[0].0;
        }
        let total: u64 = frames.iter().map(|(_, ms)| ms).sum();
        let mut offset = (self.elapsed() % u128::from(total)) as u64;
        for &(text, ms) in frames {
            if offset < ms {
                self.request(ms - offset);
                return text;
            }
            offset -= ms;
        }
        unreachable!()
    }
    /// A slow, shallow 2.8s breath, sampled at 12.5Hz, not a brightness flash.
    pub fn breath(&mut self) -> f32 {
        if !self.enabled {
            return 0.45;
        }
        self.request(80 - (self.elapsed() % 80) as u64);
        let phase = (self.elapsed() % 2800) as f32 / 2800.0;
        (1.0 - (phase * std::f32::consts::TAU).cos()) * 0.5
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_width::UnicodeWidthStr;
    #[test]
    fn motion_keeps_cells_holds_and_demand_deadlines_without_offscreen_polling() {
        for (frames, width) in [
            (FAMILIAR, 3),
            (ORBIT_SMALL, 1),
            (ORBIT_SMALL_ASCII, 1),
            (SPRING, 3),
            (SPRING_ASCII, 3),
        ] {
            for &(text, ms) in frames {
                assert_eq!(text.width(), width);
                assert_eq!(text.width_cjk(), width);
                assert!(ms > 0);
            }
        }
        assert_eq!(SPRING.iter().map(|(_, ms)| ms).sum::<u64>(), 1160);
        assert_eq!(FAMILIAR.iter().map(|(_, ms)| ms).sum::<u64>(), 3870);
        let mut motion = Motion::default();
        let start = motion.origin;
        motion.begin(start, true);
        assert!(motion.wait(start).is_none());
        assert_eq!(motion.frame(Loop::Familiar, false), "o_o");
        assert_eq!(motion.wait(start), Some(Duration::from_millis(900)));
        motion.begin(start + Duration::from_millis(900), true);
        assert_eq!(motion.frame(Loop::Familiar, true), ">_>");
        motion.begin(start, true);
        assert_eq!(motion.frame(Loop::Spring, false), "⣀⡀ ");
        assert_eq!(motion.wait(start), Some(Duration::from_millis(170)));
        motion.begin(start + Duration::from_millis(169), true);
        assert_eq!(motion.frame(Loop::Spring, false), "⣀⡀ ");
        assert_eq!(
            motion.wait(start + Duration::from_millis(169)),
            Some(Duration::from_millis(1))
        );
        motion.begin(start + Duration::from_millis(170), true);
        assert_eq!(motion.frame(Loop::Spring, false), "⣤  ");
        motion.frame(Loop::OrbitSmall, false);
        assert_eq!(
            motion.wait(start + Duration::from_millis(170)),
            Some(Duration::from_millis(10))
        );
        motion.begin(start + Duration::from_millis(1400), true);
        assert_eq!(motion.breath(), 1.0);
        motion.begin(start + Duration::from_millis(2800), true);
        assert_eq!(motion.breath(), 0.0);
        motion.begin(start, false);
        motion.frame(Loop::OrbitSmall, true);
        motion.breath();
        assert!(motion.wait(start).is_none());
        motion.begin(start, true); // no widget requested a frame after navigation
        assert!(motion.wait(start).is_none());
    }
}
