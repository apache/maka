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

//! The hop of a sidebar icon under the pointer, as AllSum's icons hop: when
//! the pointer enters its row the icon lifts about 2px and settles back over
//! 180ms, eased out, once per entry. It moves the icon's SVG as it is
//! painted (a transform), so nothing around it moves and the row's hover
//! fill stays as it is. With the system's Reduce motion on, icons do not
//! hop.
//!
//! The view that draws the icons owns their [`Hops`]: the pointer's entry
//! starts one ([`Hops::enter`], then the view notifies), and each frame
//! draws the icon where its hop has it ([`Hops::icon`]), asking for the next
//! frame until the hop has settled.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use gpui_kit::base::animation::ease_out_cubic;
use gpui_kit::component::Icon;
use gpui_kit::{App, Transformation, Window, point, px};

/// How long a hop takes, up and back.
pub const HOP_DURATION: Duration = Duration::from_millis(180);

/// How high an icon lifts: 2px at the default rem.
const HOP_HEIGHT_REMS: f32 = 0.125;

/// The hops of one view's icons, each named by a key the view chooses.
#[derive(Debug, Default)]
pub struct Hops {
    started: HashMap<&'static str, Instant>,
}

impl Hops {
    pub fn new() -> Self {
        Self::default()
    }

    /// The pointer entered the row of `key`'s icon: it hops from now,
    /// unless motion is reduced. `true` when a hop started, for the owner
    /// to notify.
    pub fn enter(&mut self, key: &'static str, cx: &App) -> bool {
        if cx.reduce_motion() {
            return false;
        }
        self.started.insert(key, cx.background_executor().now());
        true
    }

    /// Whether `key`'s icon is in the air.
    pub fn hopping(&self, key: &'static str, cx: &App) -> bool {
        self.lift(key, cx).is_some()
    }

    /// `icon` where its hop has it now, asking for the next frame while the
    /// hop runs; `icon` as it is once it has settled or never hopped.
    pub fn icon(&self, key: &'static str, icon: Icon, window: &mut Window, cx: &App) -> Icon {
        let Some(lift) = self.lift(key, cx) else {
            return icon;
        };
        window.request_animation_frame();
        let offset = window.rem_size() * (HOP_HEIGHT_REMS * lift);
        icon.transform(Transformation::translate(point(px(0.), -offset)))
    }

    fn lift(&self, key: &'static str, cx: &App) -> Option<f32> {
        let started = self.started.get(key)?;
        hop_lift(cx.background_executor().now().saturating_duration_since(*started))
    }
}

/// How high a hop has the icon `elapsed` into it, as a share of the hop's
/// height: up fast and back slowly (a half sine over eased-out time), or
/// `None` once it has settled.
pub fn hop_lift(elapsed: Duration) -> Option<f32> {
    if elapsed >= HOP_DURATION {
        return None;
    }
    let progress = elapsed.as_secs_f32() / HOP_DURATION.as_secs_f32();
    Some((std::f32::consts::PI * ease_out_cubic(progress)).sin())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hop_lifts_early_and_settles_by_its_end() {
        assert_eq!(hop_lift(Duration::ZERO), Some(0.));
        let at = |ms: u64| hop_lift(Duration::from_millis(ms)).expect("in the air");
        // Eased out: the top comes in the first quarter.
        let peak = (0..180).map(at).fold(0., f32::max);
        assert!(peak > 0.99, "{peak}");
        let top = (0..180).find(|&ms| at(ms) == peak).expect("a top");
        assert!(top < 45, "the top at {top}ms");
        assert!(at(120) < at(60), "then down");
        assert!(at(179) < 0.01, "almost back");
        assert_eq!(hop_lift(HOP_DURATION), None, "settled");
    }
}
