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

//! UI integration tests: the companion in a headless window, over a pack
//! installed in a temporary State Root, stepped with the test clock.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, TestAppContext, Window,
    WindowHandle, div, px, size,
};
use host_protocol::SessionStatus;

use crate::store::tests::{TempDir, pack_manifest, sprite_png};
use crate::{
    PetActivityInput, PetActivityState, PetCompanion, PetPackId, PetPackStore, validate_manifest,
};

/// A window-sized click target under the companion, as the shell's views
/// are.
struct Shell {
    companion: Entity<PetCompanion>,
    clicks: Rc<Cell<u32>>,
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let clicks = self.clicks.clone();
        div()
            .id("shell")
            .size_full()
            .on_click(move |_, _, _| clicks.set(clicks.get() + 1))
            .child(self.companion.clone())
    }
}

struct Harness {
    _root: TempDir,
    state_root: std::path::PathBuf,
    companion: Entity<PetCompanion>,
    window: WindowHandle<Shell>,
    clicks: Rc<Cell<u32>>,
}

impl Harness {
    fn open(cx: &mut TestAppContext) -> Self {
        cx.update(gpui_kit::init);
        let root = TempDir::new("companion");
        let state_root = root.0.join("state");
        let store = PetPackStore::new(&state_root);
        let manifest = validate_manifest(&pack_manifest("pixel")).expect("valid");
        store.install(&manifest, &sprite_png(16, 2, 2)).expect("install");
        let companion = cx.new(|_| PetCompanion::new());
        let clicks = Rc::new(Cell::new(0));
        let window = cx.open_window(size(px(960.), px(600.)), {
            let (companion, clicks) = (companion.clone(), clicks.clone());
            move |_, _| Shell { companion, clicks }
        });
        Self { _root: root, state_root, companion, window, clicks }
    }

    fn select(&self, id: Option<&str>, cx: &mut TestAppContext) {
        let root = self.state_root.clone();
        let id = id.map(|id| PetPackId::parse(id).expect("id"));
        self.companion.update(cx, |companion, cx| companion.set_selection(root, id, cx));
        cx.run_until_parked();
    }

    fn frame(&self, cx: &mut TestAppContext) -> Option<u32> {
        self.companion.read_with(cx, |companion, cx| companion.frame(cx))
    }

    fn advance(&self, millis: u64, cx: &mut TestAppContext) {
        cx.executor().advance_clock(Duration::from_millis(millis));
        cx.run_until_parked();
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut gpui_kit::App) -> R,
    ) -> R {
        cx.update_window(self.window.into(), |_, window, cx| f(window, cx)).expect("window")
    }

    fn drawn(&self, cx: &mut TestAppContext) -> bool {
        self.with_window(cx, |window, cx| {
            window.render_frame(cx);
            window.try_find("pet-companion-frame").is_some()
        })
    }

    fn set(&self, input: PetActivityInput, task: &str, cx: &mut TestAppContext) {
        let task = Some(SharedString::from(task.to_owned()));
        self.companion.update(cx, |companion, cx| companion.set_activity(&input, task, cx));
        cx.run_until_parked();
    }
}

fn working() -> PetActivityInput {
    PetActivityInput::new(true, false, true, Some(SessionStatus::Running))
}

fn idle() -> PetActivityInput {
    PetActivityInput::new(true, false, false, Some(SessionStatus::Active))
}

#[gpui_kit::test]
fn the_companion_plays_the_task_state_and_hands_ready_back(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    assert!(!harness.drawn(cx), "no pet is chosen");
    harness.select(Some("pixel"), cx);
    assert!(harness.drawn(cx));
    // Idle loops frames 0 and 1 at 4 fps.
    assert_eq!(harness.frame(cx), Some(0));
    harness.advance(250, cx);
    assert_eq!(harness.frame(cx), Some(1));
    harness.advance(250, cx);
    assert_eq!(harness.frame(cx), Some(0));

    // A running turn works: frames 1 and 2, from the start.
    harness.set(working(), "task-1", cx);
    assert_eq!(harness.companion.read_with(cx, |c, _| c.playback()), PetActivityState::Working);
    assert_eq!(harness.frame(cx), Some(1));
    harness.advance(125, cx);
    assert_eq!(harness.frame(cx), Some(2));

    // The turn ends: ready plays once (3, then 0), then idle again.
    harness.set(idle(), "task-1", cx);
    harness.companion.update(cx, |companion, cx| companion.turn_completed(cx));
    cx.run_until_parked();
    assert_eq!(harness.companion.read_with(cx, |c, _| c.playback()), PetActivityState::Ready);
    assert_eq!(harness.frame(cx), Some(3));
    harness.advance(250, cx);
    assert_eq!(harness.frame(cx), Some(0));
    harness.advance(250, cx);
    assert_eq!(harness.companion.read_with(cx, |c, _| c.playback()), PetActivityState::Idle);

    // A question waiting on the person asks for input; another task
    // starts from its own state.
    harness.set(
        PetActivityInput::new(true, true, true, Some(SessionStatus::Running)),
        "task-1",
        cx,
    );
    assert_eq!(harness.companion.read_with(cx, |c, _| c.playback()), PetActivityState::NeedsInput);
    assert_eq!(harness.frame(cx), Some(2));
    harness.set(
        PetActivityInput::new(true, false, false, Some(SessionStatus::Blocked)),
        "task-2",
        cx,
    );
    assert_eq!(harness.frame(cx), Some(3), "blocked");

    // Turning the pet off draws nothing.
    harness.select(None, cx);
    assert!(!harness.drawn(cx));
}

#[gpui_kit::test]
fn reduced_motion_holds_the_first_frame(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update(|cx| cx.set_reduce_motion(true));
    harness.select(Some("pixel"), cx);
    assert_eq!(harness.frame(cx), Some(0));
    harness.advance(1_000, cx);
    assert_eq!(harness.frame(cx), Some(0), "no frame advances");
    harness.set(working(), "task-1", cx);
    assert_eq!(harness.frame(cx), Some(1), "the new state's first frame");
    harness.companion.update(cx, |companion, cx| companion.turn_completed(cx));
    cx.run_until_parked();
    harness.advance(5_000, cx);
    // Nothing plays through, so ready stays on its first frame, as in Desktop.
    assert_eq!(harness.frame(cx), Some(3));
}

#[gpui_kit::test]
fn the_companion_takes_no_pointer_events(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    cx.update(|cx| cx.set_reduce_motion(true));
    harness.select(Some("pixel"), cx);
    harness.with_window(cx, |window, cx| {
        window.render_frame(cx);
        let bounds = window.find("pet-companion-frame").bounds();
        assert!(
            bounds.right() > px(900.) && bounds.bottom() > px(540.),
            "bottom right: {bounds:?}"
        );
        window.click("pet-companion-frame", cx);
    });
    assert_eq!(harness.clicks.get(), 1, "the click reached what lies beneath");
}

#[gpui_kit::test]
fn an_unreadable_pack_shows_nothing(cx: &mut TestAppContext) {
    let harness = Harness::open(cx);
    harness.select(Some("missing"), cx);
    assert!(!harness.drawn(cx));
    // A sheet damaged behind the library's back fails closed too.
    // Test setup writes the damaged file synchronously.
    #[allow(clippy::disallowed_methods)]
    std::fs::write(harness.state_root.join("pets/v1/pixel/art/sheet.png"), b"not a png")
        .expect("damage");
    harness.select(Some("pixel"), cx);
    assert!(!harness.drawn(cx));
}
