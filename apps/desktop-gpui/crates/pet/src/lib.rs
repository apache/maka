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

//! Custom pets, as Maka Desktop has them: a person imports a `maka.pet/v1`
//! pack (a folder with a `pet.json` and one sprite sheet), and the one they
//! choose sits at the bottom right of the main window, playing an
//! animation for what the task shown is doing. Maka ships and enables no
//! pet.
//!
//! - [`validate_manifest`] checks a manifest as packages/core/src/pet.ts
//!   does, naming every issue.
//! - [`PetPackStore`] is the library in the State Root
//!   (`<stateRoot>/pets/v1/`), written by the same rules as Desktop's, so
//!   both clients see one library; [`import_from_directory`] installs a
//!   picked folder into it.
//! - [`derive_activity_state`] and [`sync_playback_state`] turn the task's
//!   signals into the state that plays; [`PetCompanion`] draws it.
//!
//! The selection itself is a client preference, which the settings crate
//! keeps and the shell hands to the companion.

mod activity;
mod companion;
mod import;
mod manifest;
mod store;

pub use activity::{
    PetActivityInput, PetAnimationSample, derive_activity_state, frame_source_rect, next_frame_at,
    sample_animation, sync_playback_state,
};
pub use companion::PetCompanion;
pub use import::{PetImportFailure, import_from_directory};
pub use manifest::{
    IssueCode, ManifestIssue, PET_ANIMATION_FPS_MAX, PET_PACK_SCHEMA_V1, PetActivityState,
    PetAnimation, PetPackId, PetPackManifest, PetSpriteFormat, PetSpriteSheet, is_safe_asset_path,
    resolve_animation_fallback, resolve_animation_state, validate_manifest,
};
pub use store::{
    PET_PACK_DIRECTORY, PET_PACK_MANIFEST_FILE, PET_PACK_MANIFEST_MAX_BYTES,
    PET_PACK_SPRITE_SHEET_MAX_BYTES, PetPackStore, PetPackStoreError, PetSpriteSheetAsset,
    StoreErrorCode, image_dimensions,
};

#[cfg(test)]
mod tests;
