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

//! The companion: the selected pack drawn at the bottom right of the main
//! window, playing the animation for the task the window shows (Maka
//! Desktop's custom-pet-companion.tsx and custom-pet-companion.css).
//!
//! It is decoration: it takes no pointer events (it has no handlers, so it
//! has no hitbox, and whatever lies beneath it stays the only surface the
//! pointer reaches), no focus, and no accessible name. A pack that cannot
//! be read shows nothing rather than a broken image. With reduced motion it
//! holds the first frame of the state's animation.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::{
    App, AppContext as _, Context, IntoElement, ParentElement as _, Render, RenderImage,
    SharedString, Styled as _, StyledImage as _, Task, Window, div, img, rems,
};
use gpui_kit::{InteractiveElement as _, ObjectFit, TestSupportExt as _};

use crate::activity::{
    PetActivityInput, derive_activity_state, frame_source_rect, next_frame_at, sample_animation,
    sync_playback_state,
};
use crate::manifest::{
    PetActivityState, PetPackId, PetPackManifest, PetSpriteFormat, resolve_animation_fallback,
    resolve_animation_state,
};
use crate::store::PetPackStore;

/// The drawn size: Desktop's `min(8rem, 22vw)` wide, at most as tall. The
/// window's minimum size keeps 22% of it above 8rem.
const COMPANION_REMS: f32 = 8.;
/// Desktop's `--space-5` from the window's right and bottom edges.
const COMPANION_INSET_REMS: f32 = 1.25;

/// A pack ready to draw: its manifest and each frame of its sheet as its
/// own image.
struct LoadedPet {
    manifest: PetPackManifest,
    frames: Vec<Arc<RenderImage>>,
}

/// Behavior and presentation owner of the companion. The shell tells it the
/// library and the selected pack ([`Self::set_selection`]), what the task
/// shown is doing ([`Self::set_activity`]), and when a turn finished
/// ([`Self::turn_completed`]); it loads the pack in the background, keeps
/// the state that plays, and advances frames on a timer at the
/// animation's rate (at most 60 per second, as the manifest bounds it).
pub struct PetCompanion {
    selection: Option<(PathBuf, PetPackId)>,
    pet: Option<LoadedPet>,
    /// Incremented for every load; a result of an older one is dropped.
    generation: u64,
    activity: PetActivityState,
    playback: PetActivityState,
    /// The resolved state whose animation plays, and since when.
    playing: Option<(PetActivityState, Instant)>,
    sequence_index: usize,
    context_key: Option<SharedString>,
    _load: Option<Task<()>>,
    _tick: Option<Task<()>>,
}

impl std::fmt::Debug for PetCompanion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PetCompanion")
            .field("selection", &self.selection)
            .field("playback", &self.playback)
            .finish_non_exhaustive()
    }
}

impl Default for PetCompanion {
    fn default() -> Self {
        Self::new()
    }
}

impl PetCompanion {
    pub fn new() -> Self {
        Self {
            selection: None,
            pet: None,
            generation: 0,
            activity: PetActivityState::Idle,
            playback: PetActivityState::Idle,
            playing: None,
            sequence_index: 0,
            context_key: None,
            _load: None,
            _tick: None,
        }
    }

    /// Shows the pack `selected` from the library of the State Root at
    /// `state_root`, or nothing. A change drops what is drawn at once and
    /// loads the new pack in the background.
    pub fn set_selection(
        &mut self,
        state_root: PathBuf,
        selected: Option<PetPackId>,
        cx: &mut Context<Self>,
    ) {
        let selection = selected.map(|id| (state_root, id));
        if selection == self.selection {
            return;
        }
        self.selection = selection.clone();
        self.unload(cx);
        let Some((state_root, id)) = selection else {
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        let load = cx.background_spawn(async move { load_pet(state_root, id) });
        self._load = Some(cx.spawn(async move |this, cx| {
            let loaded = load.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match loaded {
                    Ok(pet) => {
                        this.pet = Some(pet);
                        this.playing = None;
                        this.restart(cx);
                    }
                    Err(reason) => log::warn!("the pet {id} is not shown: {reason}"),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// What the task the window shows is doing, and which task it is
    /// (`contextKey`): another task starts over from its own state.
    pub fn set_activity(
        &mut self,
        input: &PetActivityInput,
        context_key: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        let activity = derive_activity_state(input);
        let context_changed = context_key != self.context_key;
        if activity == self.activity && !context_changed {
            return;
        }
        self.activity = activity;
        self.context_key = context_key;
        let next = sync_playback_state(self.playback, activity, false, context_changed);
        self.play(next, cx);
    }

    /// A turn of the task shown finished: ready plays once, then its
    /// fallback.
    pub fn turn_completed(&mut self, cx: &mut Context<Self>) {
        let next = sync_playback_state(self.playback, self.activity, true, false);
        self.play(next, cx);
    }

    /// The state that plays now, for tests.
    pub fn playback(&self) -> PetActivityState {
        self.playback
    }

    /// The sheet frame drawn now, while a pack shows.
    pub fn frame(&self, cx: &App) -> Option<u32> {
        let pet = self.pet.as_ref()?;
        let animation = pet.manifest.animation_for(self.playback);
        let index = if cx.reduce_motion() { 0 } else { self.sequence_index };
        animation.frames.get(index).copied()
    }

    fn play(&mut self, state: PetActivityState, cx: &mut Context<Self>) {
        self.playback = state;
        self.restart(cx);
    }

    /// Starts the playing state's animation over when the state it
    /// resolves to changed (Desktop's canvas effect runs again only then).
    fn restart(&mut self, cx: &mut Context<Self>) {
        let Some(pet) = &self.pet else {
            return;
        };
        let resolved = resolve_animation_state(&pet.manifest, self.playback);
        if self.playing.is_some_and(|(playing, _)| playing == resolved) {
            return;
        }
        self.playing = Some((resolved, cx.background_executor().now()));
        self.sequence_index = 0;
        cx.notify();
        self.schedule_tick(cx);
    }

    fn schedule_tick(&mut self, cx: &mut Context<Self>) {
        self._tick = None;
        let (Some(pet), Some((resolved, started))) = (&self.pet, self.playing) else {
            return;
        };
        if cx.reduce_motion() {
            return;
        }
        let animation = pet.manifest.animation_for(resolved);
        let elapsed = millis(cx.background_executor().now().saturating_duration_since(started));
        let sample = sample_animation(animation, elapsed);
        let Some(due) = next_frame_at(animation, sample, elapsed) else {
            return;
        };
        let wait = Duration::from_secs_f64(((due - elapsed) / 1_000.).max(0.));
        self._tick = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            this.update(cx, |this, cx| this.tick(cx)).ok();
        }));
    }

    /// Advances to the frame the clock is at; a finished one-shot hands
    /// over to its fallback (`onAnimationComplete`).
    fn tick(&mut self, cx: &mut Context<Self>) {
        let (Some(pet), Some((resolved, started))) = (&self.pet, self.playing) else {
            return;
        };
        let animation = pet.manifest.animation_for(resolved);
        let elapsed = millis(cx.background_executor().now().saturating_duration_since(started));
        let sample = sample_animation(animation, elapsed);
        if sample.sequence_index != self.sequence_index {
            self.sequence_index = sample.sequence_index;
            cx.notify();
        }
        if sample.complete {
            let fallback = resolve_animation_fallback(&pet.manifest, resolved);
            if self.playback == resolved {
                self.play(fallback, cx);
            }
            return;
        }
        self.schedule_tick(cx);
    }

    /// Stops drawing the pack and frees its frames.
    fn unload(&mut self, cx: &mut Context<Self>) {
        self._load = None;
        self._tick = None;
        self.playing = None;
        self.sequence_index = 0;
        if let Some(pet) = self.pet.take() {
            for frame in pet.frames {
                cx.drop_image(frame, None);
            }
            cx.notify();
        }
    }
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.
}

/// Reads the pack `id` from the library of `state_root` and cuts its sheet
/// into frames, ready to draw (BGRA, as GPUI's images are).
fn load_pet(state_root: PathBuf, id: PetPackId) -> Result<LoadedPet, String> {
    let store = PetPackStore::new(state_root);
    let manifest =
        store.get(id).map_err(|error| error.to_string())?.ok_or("it is not installed")?;
    let asset = store
        .read_sprite_sheet(id)
        .map_err(|error| error.to_string())?
        .ok_or("it is not installed")?;
    let format = match asset.format {
        PetSpriteFormat::Png => image::ImageFormat::Png,
        PetSpriteFormat::Webp => image::ImageFormat::WebP,
    };
    let sheet = image::load_from_memory_with_format(&asset.bytes, format)
        .map_err(|error| error.to_string())?
        .into_rgba8();
    let meta = manifest.sprite_sheet();
    let frames = (0..meta.frame_count)
        .map(|frame| {
            let (x, y, width, height) = frame_source_rect(frame, meta);
            let mut pixels = image::imageops::crop_imm(&sheet, x, y, width, height).to_image();
            for pixel in pixels.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .collect();
    Ok(LoadedPet { manifest, frames })
}

impl Render for PetCompanion {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let layer = div()
            .id("pet-companion")
            .absolute()
            .right(rems(COMPANION_INSET_REMS))
            .bottom(rems(COMPANION_INSET_REMS));
        let image =
            self.frame(cx).and_then(|frame| self.pet.as_ref()?.frames.get(frame as usize).cloned());
        let (Some(pet), Some(image)) = (&self.pet, image) else {
            return layer;
        };
        let sheet = pet.manifest.sprite_sheet();
        let aspect = sheet.frame_height as f32 / sheet.frame_width as f32;
        layer.child(
            div().id("pet-companion-frame").test_support().child(
                img(image)
                    .w(rems(COMPANION_REMS))
                    .h(rems(COMPANION_REMS * aspect.min(1.)))
                    .object_fit(ObjectFit::Contain),
            ),
        )
    }
}
