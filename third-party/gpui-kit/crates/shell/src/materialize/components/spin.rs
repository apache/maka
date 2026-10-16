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

//! `svg(path).spin(period_ms)` — an icon that turns continuously.
//!
//! # The angle comes from a clock
//!
//! The angle is a function of time alone: how far the current instant is
//! past one epoch shared by the whole process, modulo the period. It is not
//! a motion keyed by the element, because a script rebuilds its description
//! whenever its state changes — once per streamed token, say — and a
//! per-element animation would be keyed by an identity the rebuild may move,
//! and would start again from zero when it did. Read from a clock, every
//! rebuild lands on the angle the previous frame was heading for, and two
//! spinners with one period turn in step.
//!
//! # What keeps it turning
//!
//! Each paint asks GPUI for the next animation frame. That notifies the view
//! the spinner is drawn in, which GPUI then renders again — and a
//! [`ScriptView`](crate::ScriptView) that is notified without being
//! invalidated replays its snapshot through materialize and does not enter
//! the VM. So a spinner costs one materialization of its view per frame, and
//! no script render.
//!
//! A spinner inside a scroll container must not be composited from a cached
//! scroll layer, which would show it at the angle it was painted at. Two
//! things keep it off one. The view it is in is notified every frame, and a
//! notified view's content counts as changed. And the request is made while
//! the element is painted, so GPUI-fast records it as coming from inside the
//! container; a container whose content asks for animation frames is drawn
//! without its layer (`fast::layers::policy::eligible`) rather than painted
//! into it again on every frame.
//!
//! With reduced motion on, the icon is drawn upright and no frame is asked
//! for, as every Base transition and spring does.

use std::{sync::OnceLock, time::Duration};

use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement, LayoutId,
    Pixels, Svg, Transformation, Window, radians,
};

use crate::{materialize::Behavior, spec::Component};

/// An svg that turns once every `period` about its center.
///
/// A wrapper rather than a transformation set where the svg is built, for two
/// reasons: the angle is read when the frame is painted, and the next frame
/// is asked for from inside the element's own paint, where GPUI-fast can tell
/// which scroll container the request came from.
pub(in crate::materialize) struct SpinningSvg {
    svg: Svg,
    period: Duration,
}

impl SpinningSvg {
    pub(in crate::materialize) fn new(svg: Svg, period: Duration) -> Self {
        Self { svg, period }
    }
}

impl IntoElement for SpinningSvg {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for SpinningSvg {
    type RequestLayoutState = <Svg as Element>::RequestLayoutState;
    type PrepaintState = <Svg as Element>::PrepaintState;

    fn id(&self) -> Option<ElementId> {
        self.svg.id()
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        self.svg.source_location()
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        self.svg.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.svg
            .prepaint(id, inspector_id, bounds, state, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        if !cx.reduce_motion() {
            let angle = spin_angle(cx.background_executor().now(), self.period);
            // `Svg` takes its transformation by value only.
            let svg = std::mem::replace(&mut self.svg, gpui::svg());
            self.svg = svg.with_transformation(Transformation::rotate(radians(angle)));
            #[cfg(test)]
            PAINTED_ANGLES.with(|angles| angles.borrow_mut().push(angle));
            window.request_animation_frame();
        }
        self.svg
            .paint(id, inspector_id, bounds, state, prepaint, window, cx);
    }
}

/// The angle, in radians, a spinner with this period shows at `now`.
///
/// Measured from one epoch for the whole process — the first instant any
/// spinner was painted at — and well defined for an instant before it, which
/// a test clock started earlier than the epoch can produce.
pub(in crate::materialize) fn spin_angle(now: std::time::Instant, period: Duration) -> f32 {
    static EPOCH: OnceLock<std::time::Instant> = OnceLock::new();
    phase_angle(now, *EPOCH.get_or_init(|| now), period)
}

fn phase_angle(now: std::time::Instant, epoch: std::time::Instant, period: Duration) -> f32 {
    let period = period.as_nanos();
    if period == 0 {
        return 0.;
    }
    let phase = match now.checked_duration_since(epoch) {
        Some(since) => since.as_nanos() % period,
        None => (period - (epoch - now).as_nanos() % period) % period,
    };
    (phase as f64 / period as f64 * std::f64::consts::TAU) as f32
}

/// Reports a `spin` on anything but an svg.
///
/// Every element shares one prototype, so the method reaches a `div` or an
/// `image(...)` too, and there it would do nothing. Called once from
/// [`materialize_node`](crate::materialize), as the tooltip check is.
pub(in crate::materialize) fn warn_unhonoured_spin(component: &Component, behavior: &Behavior) {
    if behavior.spin.is_none() || matches!(component, Component::Svg(_)) {
        return;
    }
    tracing::warn!(
        "`spin` is not honoured on a {}: only an `svg(...)` turns. Put `spin` on the svg \
         itself",
        component.name()
    );
}

#[cfg(test)]
thread_local! {
    /// The angles spinners were painted at on this thread, in paint order.
    static PAINTED_ANGLES: std::cell::RefCell<Vec<f32>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Takes the angles spinners were painted at on this thread since the last
/// call.
#[cfg(test)]
pub(crate) fn take_painted_spin_angles() -> Vec<f32> {
    PAINTED_ANGLES.with(|angles| std::mem::take(&mut *angles.borrow_mut()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::{FRAC_PI_2, PI, TAU};

    fn close(left: f32, right: f32) -> bool {
        (left - right).abs() < 1e-4
    }

    #[test]
    fn the_angle_is_the_phase_of_the_clock_in_the_period() {
        let epoch = std::time::Instant::now();
        let period = Duration::from_millis(1000);
        let at = |ms| phase_angle(epoch + Duration::from_millis(ms), epoch, period);
        assert!(close(at(0), 0.));
        assert!(close(at(250), FRAC_PI_2));
        assert!(close(at(500), PI));
        assert!(close(at(1000), 0.), "a whole period is a whole turn");
        assert!(
            close(at(3250), FRAC_PI_2),
            "later turns land on the same phase"
        );
    }

    #[test]
    fn an_instant_before_the_epoch_continues_the_same_rotation() {
        let epoch = std::time::Instant::now() + Duration::from_secs(10);
        let period = Duration::from_millis(1000);
        let before = phase_angle(epoch - Duration::from_millis(250), epoch, period);
        assert!(close(before, 3. * FRAC_PI_2), "{before}");
        let exactly = phase_angle(epoch - Duration::from_millis(2000), epoch, period);
        assert!(close(exactly, 0.), "{exactly}");
    }

    #[test]
    fn the_angle_stays_within_one_turn() {
        let epoch = std::time::Instant::now();
        let period = Duration::from_millis(7);
        for ms in 0..100 {
            let angle = phase_angle(epoch + Duration::from_millis(ms), epoch, period);
            assert!((0. ..TAU).contains(&angle), "{ms}ms: {angle}");
        }
    }
}
