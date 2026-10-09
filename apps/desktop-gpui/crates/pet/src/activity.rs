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

//! What the companion plays, from what the window shows: Maka Desktop's
//! custom-pet-companion-model.ts (`derivePetActivityState`,
//! `syncPetPlaybackState`, `samplePetAnimation`, `petFrameSourceRect`).

use host_protocol::SessionStatus;

use crate::manifest::{PetActivityState, PetAnimation, PetSpriteSheet};

/// The shell's signals about the task it shows (`PetRuntimeActivityInput`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct PetActivityInput {
    /// A task is selected.
    pub has_active_session: bool,
    /// The task waits on a permission prompt or a question.
    pub has_active_interaction: bool,
    /// A turn of the task runs.
    pub turn_active: bool,
    /// The task's status in the session catalog.
    pub session_status: Option<SessionStatus>,
}

impl PetActivityInput {
    pub fn new(
        has_active_session: bool,
        has_active_interaction: bool,
        turn_active: bool,
        session_status: Option<SessionStatus>,
    ) -> Self {
        Self { has_active_session, has_active_interaction, turn_active, session_status }
    }
}

/// `derivePetActivityState`: nothing selected is idle; a question or a wait
/// on the person asks for input; a blocked task is blocked; a running turn
/// works. A finished turn is the separate [`sync_playback_state`] pulse:
/// its task goes back to active, which reads the same as any idle one.
pub fn derive_activity_state(input: &PetActivityInput) -> PetActivityState {
    if !input.has_active_session {
        return PetActivityState::Idle;
    }
    if input.has_active_interaction || input.session_status == Some(SessionStatus::WaitingForUser) {
        return PetActivityState::NeedsInput;
    }
    if input.session_status == Some(SessionStatus::Blocked) {
        return PetActivityState::Blocked;
    }
    if input.turn_active {
        return PetActivityState::Working;
    }
    PetActivityState::Idle
}

/// `syncPetPlaybackState`: a finished turn plays ready; another task, or
/// anything but idle, plays the activity; idle keeps a ready that is still
/// playing (its own fallback ends it).
pub fn sync_playback_state(
    current: PetActivityState,
    activity: PetActivityState,
    completion_arrived: bool,
    context_changed: bool,
) -> PetActivityState {
    if completion_arrived {
        return PetActivityState::Ready;
    }
    if context_changed || activity != PetActivityState::Idle {
        return activity;
    }
    if current == PetActivityState::Ready {
        PetActivityState::Ready
    } else {
        PetActivityState::Idle
    }
}

/// One moment of an animation (`PetAnimationSample`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PetAnimationSample {
    /// The sheet's frame to draw.
    pub frame: u32,
    /// Where in the animation's frame list it is.
    pub sequence_index: usize,
    /// A non-looping animation has shown its last frame for its full time.
    pub complete: bool,
}

/// `samplePetAnimation`: the frame `elapsed_ms` into `animation`, from the
/// time alone, so a late tick never slows it down.
pub fn sample_animation(animation: &PetAnimation, elapsed_ms: f64) -> PetAnimationSample {
    let elapsed = if elapsed_ms.is_finite() { elapsed_ms.max(0.) } else { 0. };
    let count = animation.frames.len().max(1);
    // Non-negative and far below usize::MAX for any real elapsed time.
    let unbounded = ((elapsed * f64::from(animation.fps)) / 1_000.).floor() as usize;
    let complete = !animation.looping && unbounded >= count;
    let sequence_index =
        if animation.looping { unbounded % count } else { unbounded.min(count - 1) };
    PetAnimationSample {
        frame: animation.frames.get(sequence_index).copied().unwrap_or_default(),
        sequence_index,
        complete,
    }
}

/// When, in milliseconds after the animation started, the frame after
/// `sample` is due, or `None` once a non-looping animation has ended.
pub fn next_frame_at(
    animation: &PetAnimation,
    sample: PetAnimationSample,
    elapsed_ms: f64,
) -> Option<f64> {
    if sample.complete {
        return None;
    }
    let fps = f64::from(animation.fps.max(1));
    let step = (elapsed_ms.max(0.) * fps / 1_000.).floor() + 1.;
    Some(step * 1_000. / fps)
}

/// `petFrameSourceRect`: where frame `frame` sits in the sheet, in pixels
/// (x, y, width, height), read row by row.
pub fn frame_source_rect(frame: u32, sheet: &PetSpriteSheet) -> (u32, u32, u32, u32) {
    let columns = sheet.columns.max(1);
    (
        (frame % columns) * sheet.frame_width,
        (frame / columns) * sheet.frame_height,
        sheet.frame_width,
        sheet.frame_height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::validate_manifest;
    use PetActivityState::*;

    fn input(
        session: bool,
        interaction: bool,
        turn: bool,
        status: Option<SessionStatus>,
    ) -> PetActivityInput {
        PetActivityInput::new(session, interaction, turn, status)
    }

    #[test]
    fn the_task_state_maps_to_the_pack_contract_as_desktop_derives_it() {
        use SessionStatus as S;
        for (given, expected) in [
            (input(false, true, true, Some(S::Blocked)), Idle),
            (input(true, false, false, Some(S::Active)), Idle),
            (input(true, false, true, Some(S::Running)), Working),
            (input(true, true, true, Some(S::Running)), NeedsInput),
            (input(true, false, true, Some(S::WaitingForUser)), NeedsInput),
            (input(true, false, true, Some(S::Blocked)), Blocked),
            (input(true, true, false, Some(S::Blocked)), NeedsInput),
            (input(true, false, false, None), Idle),
            (input(true, false, true, Some(S::Aborted)), Working),
        ] {
            assert_eq!(derive_activity_state(&given), expected, "{given:?}");
        }
    }

    #[test]
    fn a_finished_turn_plays_ready_until_its_own_fallback_ends_it() {
        assert_eq!(sync_playback_state(Working, Idle, true, false), Ready, "completion wins");
        assert_eq!(sync_playback_state(Ready, Idle, false, false), Ready, "ready keeps playing");
        assert_eq!(sync_playback_state(Ready, Idle, false, true), Idle, "another task");
        assert_eq!(sync_playback_state(Ready, Working, false, false), Working);
        assert_eq!(sync_playback_state(Working, Idle, false, false), Idle);
        assert_eq!(sync_playback_state(Idle, Blocked, false, false), Blocked);
    }

    #[test]
    fn samples_follow_the_clock_and_one_shots_complete() {
        let manifest =
            validate_manifest(&crate::store::tests::pack_manifest("pixel")).expect("valid");
        let idle = manifest.animation(Idle).expect("idle"); // [0, 1] at 4 fps, looping
        let at = |ms: f64| sample_animation(idle, ms);
        assert_eq!(at(0.).frame, 0);
        assert_eq!(at(249.).frame, 0);
        assert_eq!(at(250.).frame, 1);
        assert_eq!((at(500.).frame, at(500.).sequence_index, at(500.).complete), (0, 0, false));
        assert_eq!(at(-5.).frame, 0);
        assert_eq!(at(f64::NAN).frame, 0);
        assert_eq!(next_frame_at(idle, at(260.), 260.), Some(500.));

        let ready = manifest.animation(Ready).expect("ready"); // [3, 0] at 4 fps, once
        let at = |ms: f64| sample_animation(ready, ms);
        assert_eq!((at(0.).frame, at(0.).complete), (3, false));
        assert_eq!((at(499.).frame, at(499.).complete), (0, false));
        assert_eq!((at(500.).frame, at(500.).sequence_index, at(500.).complete), (0, 1, true));
        assert_eq!(next_frame_at(ready, at(500.), 500.), None);
    }

    #[test]
    fn frames_are_read_row_by_row() {
        let manifest =
            validate_manifest(&crate::store::tests::pack_manifest("pixel")).expect("valid");
        let sheet = manifest.sprite_sheet(); // 2×2 of 16px
        assert_eq!(frame_source_rect(0, sheet), (0, 0, 16, 16));
        assert_eq!(frame_source_rect(1, sheet), (16, 0, 16, 16));
        assert_eq!(frame_source_rect(3, sheet), (16, 16, 16, 16));
    }
}
