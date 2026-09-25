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

use std::time::Instant;

/// Presentation state only: changing density must never recreate page/Host state.
pub struct Chrome {
    pub sidebar_expanded: Option<bool>,
    pub session_fullscreen: bool,
    pub details: bool,
    /// The reader keeps a session's panels beside its conversation.
    pub ascii: bool,
    pub motion: bool,
    pub window_focused: bool,
    pub animation: crate::motion::Motion,
    pub header: crate::ui::Surface<crate::app::Action>,
    pub footer: crate::ui::Surface<crate::app::Action>,
    pub feedback: crate::ui::Surface<crate::app::Action>,
    pub composer: crate::ui::Surface<crate::app::Action>,
    transition: Option<Transition>,
    last_width: u16,
}

struct Transition {
    from: u16,
    to: u16,
    started: Instant,
}

impl Default for Chrome {
    fn default() -> Self {
        Self {
            sidebar_expanded: None,
            session_fullscreen: false,
            details: false,
            ascii: false,
            motion: true,
            window_focused: true,
            animation: Default::default(),
            header: Default::default(),
            footer: Default::default(),
            feedback: Default::default(),
            composer: Default::default(),
            transition: None,
            last_width: SIDEBAR,
        }
    }
}

/// The sidebar is the session directory: shown whole or not at all.
const SIDEBAR: u16 = 32;
fn open_by_default(width: u16) -> bool {
    width >= 90
}

impl Chrome {
    pub fn toggle_sidebar(&mut self, width: u16, now: Instant) {
        let expanded = !self.sidebar_expanded.unwrap_or(open_by_default(width));
        self.sidebar_expanded = Some(expanded);
        self.transition = self.motion.then_some(Transition {
            from: self.last_width,
            to: if expanded { SIDEBAR } else { 0 },
            started: now,
        });
    }

    pub fn sidebar_width(&mut self, width: u16, now: Instant) -> u16 {
        let target = if width >= 60 && self.sidebar_expanded.unwrap_or(open_by_default(width)) {
            SIDEBAR
        } else {
            0
        };
        let value = match &self.transition {
            Some(transition) if transition.to == target && self.motion => {
                let t = (now.duration_since(transition.started).as_secs_f32() / 0.16).min(1.0);
                let eased = 1.0 - (1.0 - t).powi(3);
                let value = (transition.from as f32
                    + (target as f32 - transition.from as f32) * eased)
                    .round() as u16;
                if t >= 1.0 {
                    self.transition = None;
                }
                value
            }
            _ => {
                self.transition = None;
                target
            }
        };
        self.last_width = value;
        value
    }

    pub fn animating(&self) -> bool {
        self.transition.is_some()
    }

    pub fn stop_animation(&mut self) {
        self.transition = None;
    }

    pub fn symbol<'a>(&self, unicode: &'a str, ascii: &'a str) -> &'a str {
        if self.ascii { ascii } else { unicode }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn sidebar_transition_is_reversible_bounded_and_stops_when_idle_or_reduced() {
        let mut chrome = Chrome::default();
        let now = Instant::now();
        assert_eq!(chrome.sidebar_width(120, now), 32);
        chrome.toggle_sidebar(120, now);
        let halfway = chrome.sidebar_width(120, now + Duration::from_millis(60));
        assert!((1..32).contains(&halfway));
        chrome.toggle_sidebar(120, now + Duration::from_millis(60));
        assert_eq!(
            chrome.sidebar_width(120, now + Duration::from_millis(60)),
            halfway
        );
        assert_eq!(
            chrome.sidebar_width(120, now + Duration::from_millis(220)),
            32
        );
        assert!(!chrome.animating());
        chrome.motion = false;
        chrome.toggle_sidebar(120, now);
        assert_eq!(chrome.sidebar_width(120, now), 0, "collapsed means hidden");
        assert!(!chrome.animating());
        chrome.sidebar_expanded = None;
        assert_eq!(chrome.sidebar_width(80, now), 0);
        assert_eq!(chrome.sidebar_width(90, now), 32);
    }
}
