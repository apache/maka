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

//! The `maka.pet/v1` manifest (`pet.json`): a code-free description of a
//! sprite sheet and the animation each activity state plays. Mirrors
//! packages/core/src/pet.ts: [`validate_manifest`] is its
//! `validatePetPackManifest`, issue for issue, and the resolvers are its
//! `resolvePetAnimationState` and `resolvePetAnimationFallback`.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `PET_PACK_SCHEMA_V1`.
pub const PET_PACK_SCHEMA_V1: &str = "maka.pet/v1";

/// `PET_PACK_ID_MAX_CHARS` and the other bounds of pet.ts.
pub const PET_PACK_ID_MAX_CHARS: usize = 64;
pub const PET_PACK_DISPLAY_NAME_MAX_CHARS: usize = 80;
pub const PET_PACK_DESCRIPTION_MAX_CHARS: usize = 500;
pub const PET_ASSET_PATH_MAX_CHARS: usize = 256;
pub const PET_SPRITE_FRAME_MAX_DIMENSION: u32 = 2_048;
pub const PET_SPRITE_SHEET_MAX_DIMENSION: u32 = 8_192;
pub const PET_SPRITE_GRID_MAX_AXIS: u32 = 64;
pub const PET_SPRITE_FRAME_COUNT_MAX: u32 = 256;
pub const PET_ANIMATION_FPS_MAX: u32 = 60;

/// A pack's canonical id (`isPetPackId`): one to 64 lowercase ASCII
/// letters, digits, dots, underscores, or hyphens, starting and ending with
/// a letter or a digit. It names the pack's directory in the library, so
/// nothing else ever reaches a path. Held inline, so a preference that
/// names one stays `Copy`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PetPackId {
    len: u8,
    bytes: [u8; PET_PACK_ID_MAX_CHARS],
}

impl PetPackId {
    /// `value` when it is a canonical id.
    pub fn parse(value: &str) -> Option<Self> {
        let bytes = value.as_bytes();
        let edge = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
        let inner = |byte: &u8| edge(byte) || matches!(byte, b'.' | b'_' | b'-');
        let valid = !bytes.is_empty()
            && bytes.len() <= PET_PACK_ID_MAX_CHARS
            && bytes.first().is_some_and(edge)
            && bytes.last().is_some_and(edge)
            && bytes.iter().all(inner);
        if !valid {
            return None;
        }
        let mut id = Self { len: bytes.len() as u8, bytes: [0; PET_PACK_ID_MAX_CHARS] };
        id.bytes[..bytes.len()].copy_from_slice(bytes);
        Some(id)
    }

    pub fn as_str(&self) -> &str {
        // Only ASCII is ever admitted.
        std::str::from_utf8(&self.bytes[..usize::from(self.len)]).unwrap_or_default()
    }

    /// Orders ids as the library lists them: Desktop sorts directory names
    /// with `localeCompare`, whose root collation puts `_` before `-`
    /// before `.` before the digits before the letters.
    pub fn collation_key(&self) -> Vec<u8> {
        self.as_str()
            .bytes()
            .map(|byte| match byte {
                b'_' => 0,
                b'-' => 1,
                b'.' => 2,
                b'0'..=b'9' => 3 + (byte - b'0'),
                _ => 13 + (byte - b'a'),
            })
            .collect()
    }
}

impl fmt::Debug for PetPackId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PetPackId({:?})", self.as_str())
    }
}

impl fmt::Display for PetPackId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for PetPackId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PetPackId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| serde::de::Error::custom("not a canonical pet pack id"))
    }
}

/// The states a pack animates (`PET_ACTIVITY_STATES`): five a pack must
/// draw, and five it may, each falling back to a required one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum PetActivityState {
    Idle,
    Working,
    NeedsInput,
    Ready,
    Blocked,
    Swarm,
    Cancelled,
    Poke,
    Wake,
    Sleep,
}

impl PetActivityState {
    /// `PET_REQUIRED_ACTIVITY_STATES`.
    pub const REQUIRED: [Self; 5] =
        [Self::Idle, Self::Working, Self::NeedsInput, Self::Ready, Self::Blocked];
    /// `PET_OPTIONAL_ACTIVITY_STATES`.
    pub const OPTIONAL: [Self; 5] =
        [Self::Swarm, Self::Cancelled, Self::Poke, Self::Wake, Self::Sleep];
    /// `PET_ACTIVITY_STATES`: the required ones, then the optional ones.
    pub const ALL: [Self; 10] = [
        Self::Idle,
        Self::Working,
        Self::NeedsInput,
        Self::Ready,
        Self::Blocked,
        Self::Swarm,
        Self::Cancelled,
        Self::Poke,
        Self::Wake,
        Self::Sleep,
    ];

    /// The state's name in a manifest.
    pub fn key(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::NeedsInput => "needs-input",
            Self::Ready => "ready",
            Self::Blocked => "blocked",
            Self::Swarm => "swarm",
            Self::Cancelled => "cancelled",
            Self::Poke => "poke",
            Self::Wake => "wake",
            Self::Sleep => "sleep",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|state| state.key() == key)
    }

    /// The required state a pack without this one plays instead
    /// (`PET_ACTIVITY_STATE_FALLBACKS`).
    pub fn fallback(self) -> Self {
        match self {
            Self::Swarm => Self::Working,
            Self::Cancelled | Self::Poke | Self::Wake | Self::Sleep => Self::Idle,
            required => required,
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// `PET_SPRITE_FORMATS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PetSpriteFormat {
    Png,
    Webp,
}

impl PetSpriteFormat {
    pub fn key(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Webp => "webp",
        }
    }

    fn from_key(key: &str) -> Option<Self> {
        match key {
            "png" => Some(Self::Png),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

/// `PetSpriteSheetV1`: one image, a grid of equal frames read row by row.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PetSpriteSheet {
    /// The image, relative to the pack's directory, `/`-separated.
    pub path: String,
    pub format: PetSpriteFormat,
    pub frame_width: u32,
    pub frame_height: u32,
    pub columns: u32,
    pub rows: u32,
    pub frame_count: u32,
}

impl PetSpriteSheet {
    /// The pixel size the image must have.
    pub fn size(&self) -> (u32, u32) {
        (self.frame_width * self.columns, self.frame_height * self.rows)
    }
}

/// `PetAnimationV1`: frames of the sheet played at `fps`, looping or once.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PetAnimation {
    pub frames: Vec<u32>,
    pub fps: u32,
    pub looping: bool,
    /// The state a non-looping animation hands over to when it ends; idle
    /// when unset.
    pub fallback: Option<PetActivityState>,
}

/// A validated `PetPackManifestV1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PetPackManifest {
    id: PetPackId,
    display_name: String,
    description: Option<String>,
    sprite_sheet: PetSpriteSheet,
    /// By [`PetActivityState::index`]; the required five are always set.
    animations: [Option<PetAnimation>; 10],
}

impl PetPackManifest {
    pub fn id(&self) -> PetPackId {
        self.id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn sprite_sheet(&self) -> &PetSpriteSheet {
        &self.sprite_sheet
    }

    /// The pack's own animation for `state`, if it draws one.
    pub fn animation(&self, state: PetActivityState) -> Option<&PetAnimation> {
        self.animations[state.index()].as_ref()
    }

    /// The animation `state` plays: its own, else its fallback's
    /// ([`resolve_animation_state`]), else idle's.
    pub fn animation_for(&self, state: PetActivityState) -> &PetAnimation {
        let resolved = resolve_animation_state(self, state);
        self.animation(resolved)
            .or_else(|| self.animation(PetActivityState::Idle))
            .unwrap_or(&IDLE_PLACEHOLDER)
    }

    /// The manifest as the library stores it (`snapshotManifest` in
    /// packages/storage/src/pet-pack-store.ts, written with
    /// `JSON.stringify(manifest, null, 2)` and a newline).
    pub fn to_stored_json(&self) -> String {
        let sheet = &self.sprite_sheet;
        let animation = |state: PetActivityState| {
            self.animation(state).map(|animation| StoredAnimation {
                frames: animation.frames.clone(),
                fps: animation.fps,
                looping: animation.looping,
                fallback: animation.fallback.map(PetActivityState::key),
            })
        };
        let stored = StoredManifest {
            schema: PET_PACK_SCHEMA_V1,
            id: self.id.as_str(),
            display_name: &self.display_name,
            description: self.description.as_deref(),
            sprite_sheet: StoredSpriteSheet {
                path: &sheet.path,
                format: sheet.format.key(),
                frame_width: sheet.frame_width,
                frame_height: sheet.frame_height,
                columns: sheet.columns,
                rows: sheet.rows,
                frame_count: sheet.frame_count,
            },
            animations: StoredAnimations {
                idle: animation(PetActivityState::Idle),
                working: animation(PetActivityState::Working),
                needs_input: animation(PetActivityState::NeedsInput),
                ready: animation(PetActivityState::Ready),
                blocked: animation(PetActivityState::Blocked),
                swarm: animation(PetActivityState::Swarm),
                cancelled: animation(PetActivityState::Cancelled),
                poke: animation(PetActivityState::Poke),
                wake: animation(PetActivityState::Wake),
                sleep: animation(PetActivityState::Sleep),
            },
        };
        let mut text = serde_json::to_string_pretty(&stored).unwrap_or_default();
        text.push('\n');
        text
    }
}

/// What [`PetPackManifest::animation_for`] answers for a manifest that
/// lost its idle animation, which validation makes impossible.
static IDLE_PLACEHOLDER: PetAnimation =
    PetAnimation { frames: Vec::new(), fps: 1, looping: true, fallback: None };

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredManifest<'a> {
    schema: &'a str,
    id: &'a str,
    display_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
    sprite_sheet: StoredSpriteSheet<'a>,
    animations: StoredAnimations,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSpriteSheet<'a> {
    path: &'a str,
    format: &'a str,
    frame_width: u32,
    frame_height: u32,
    columns: u32,
    rows: u32,
    frame_count: u32,
}

#[derive(Serialize)]
struct StoredAnimations {
    idle: Option<StoredAnimation>,
    working: Option<StoredAnimation>,
    #[serde(rename = "needs-input")]
    needs_input: Option<StoredAnimation>,
    ready: Option<StoredAnimation>,
    blocked: Option<StoredAnimation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    swarm: Option<StoredAnimation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<StoredAnimation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poke: Option<StoredAnimation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wake: Option<StoredAnimation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sleep: Option<StoredAnimation>,
}

#[derive(Serialize)]
struct StoredAnimation {
    frames: Vec<u32>,
    fps: u32,
    #[serde(rename = "loop")]
    looping: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback: Option<&'static str>,
}

/// `PetManifestValidationIssueCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueCode {
    InvalidType,
    MissingField,
    UnknownField,
    InvalidValue,
    OutOfRange,
    UnsafePath,
    MissingAnimation,
    InvalidReference,
}

/// `PetManifestValidationIssue`: what is wrong, and where (`$.spriteSheet.path`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ManifestIssue {
    pub code: IssueCode,
    pub path: String,
    pub message: String,
}

/// `resolvePetAnimationState`: `requested` when the pack draws it, else its
/// fallback.
pub fn resolve_animation_state(
    manifest: &PetPackManifest,
    requested: PetActivityState,
) -> PetActivityState {
    if manifest.animation(requested).is_some() { requested } else { requested.fallback() }
}

/// `resolvePetAnimationFallback`: the state that plays once `state`'s
/// animation ends; the state itself while it loops.
pub fn resolve_animation_fallback(
    manifest: &PetPackManifest,
    state: PetActivityState,
) -> PetActivityState {
    let resolved = resolve_animation_state(manifest, state);
    let animation = manifest.animation_for(resolved);
    if animation.looping {
        return resolved;
    }
    resolve_animation_state(manifest, animation.fallback.unwrap_or(PetActivityState::Idle))
}

/// `isSafePetAssetPath`: a non-empty relative `/`-path of at most 256
/// characters with no empty, `.`, or `..` segment, no backslash, no drive,
/// no surrounding whitespace, and no control character.
pub fn is_safe_asset_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    let windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if value.is_empty()
        || js_length(value) > PET_ASSET_PATH_MAX_CHARS
        || js_trim(value) != value
        || value.starts_with('/')
        || value.starts_with('\\')
        || windows_drive
        || value.contains('\\')
        || value.chars().any(is_control)
    {
        return false;
    }
    value.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// A string's `length` in JavaScript: UTF-16 code units.
fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// JavaScript's `String.prototype.trim`, which strips its WhiteSpace and
/// LineTerminator characters: Unicode's white space less U+0085, plus the
/// byte order mark.
fn js_trim(value: &str) -> &str {
    let whitespace = |c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}';
    value.trim_matches(whitespace)
}

/// pet.ts's `CONTROL_CHARACTER_PATTERN`: C0, DEL, and C1.
fn is_control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// `Number.isInteger`: a JSON number with no fractional part.
fn as_integer(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.trunc() == number).then_some(number)
}

struct Issues(Vec<ManifestIssue>);

impl Issues {
    fn add(&mut self, code: IssueCode, path: impl Into<String>, message: impl Into<String>) {
        self.0.push(ManifestIssue { code, path: path.into(), message: message.into() });
    }

    /// `validateExactShape`: every required field present, no field outside
    /// `required` and `optional`.
    fn exact_shape(
        &mut self,
        value: &Map<String, Value>,
        required: &[&str],
        optional: &[&str],
        path: &str,
    ) {
        for field in required {
            if !value.contains_key(*field) {
                self.add(
                    IssueCode::MissingField,
                    format!("{path}.{field}"),
                    format!("missing required field {field}"),
                );
            }
        }
        for field in value.keys() {
            if !required.contains(&field.as_str()) && !optional.contains(&field.as_str()) {
                self.add(
                    IssueCode::UnknownField,
                    format!("{path}.{field}"),
                    format!("unknown field {field}"),
                );
            }
        }
    }

    /// `validateBoundedText`.
    fn bounded_text<'a>(
        &mut self,
        value: Option<&'a Value>,
        path: &str,
        max_chars: usize,
    ) -> Option<&'a str> {
        let Some(text) = value.and_then(Value::as_str) else {
            self.add(IssueCode::InvalidType, path, "must be a string");
            return None;
        };
        if text.is_empty() || js_trim(text) != text || text.chars().any(is_control) {
            self.add(
                IssueCode::InvalidValue,
                path,
                "must be non-empty, trimmed, and free of control characters",
            );
            return None;
        }
        if js_length(text) > max_chars {
            self.add(
                IssueCode::OutOfRange,
                path,
                format!("must be at most {max_chars} characters"),
            );
            return None;
        }
        Some(text)
    }

    /// `validateBoundedInteger`.
    fn bounded_integer(
        &mut self,
        value: Option<&Value>,
        path: &str,
        min: u32,
        max: u32,
    ) -> Option<u32> {
        let Some(number) = as_integer(value) else {
            self.add(IssueCode::InvalidType, path, "must be an integer");
            return None;
        };
        if number < f64::from(min) || number > f64::from(max) {
            self.add(IssueCode::OutOfRange, path, format!("must be between {min} and {max}"));
            return None;
        }
        // Within u32 once bounded.
        Some(number as u32)
    }

    /// `validateSpriteSheet`.
    fn sprite_sheet(&mut self, value: Option<&Value>) -> Option<PetSpriteSheet> {
        let path = "$.spriteSheet";
        let Some(sheet) = value.and_then(Value::as_object) else {
            self.add(IssueCode::InvalidType, path, "must be an object");
            return None;
        };
        self.exact_shape(
            sheet,
            &["path", "format", "frameWidth", "frameHeight", "columns", "rows", "frameCount"],
            &[],
            path,
        );
        let sprite_path =
            sheet.get("path").and_then(Value::as_str).filter(|p| is_safe_asset_path(p));
        if sprite_path.is_none() {
            self.add(
                IssueCode::UnsafePath,
                format!("{path}.path"),
                "must be a safe package-relative path",
            );
        }
        let format =
            sheet.get("format").and_then(Value::as_str).and_then(PetSpriteFormat::from_key);
        match (format, sprite_path) {
            (None, _) => {
                self.add(IssueCode::InvalidValue, format!("{path}.format"), "must be png or webp")
            }
            (Some(format), Some(sprite_path))
                if !sprite_path.to_lowercase().ends_with(&format!(".{}", format.key())) =>
            {
                self.add(
                    IssueCode::InvalidValue,
                    format!("{path}.path"),
                    format!("must end in .{}", format.key()),
                );
            }
            _ => {}
        }
        let frame = PET_SPRITE_FRAME_MAX_DIMENSION;
        let grid = PET_SPRITE_GRID_MAX_AXIS;
        let frame_width =
            self.bounded_integer(sheet.get("frameWidth"), &format!("{path}.frameWidth"), 1, frame);
        let frame_height = self.bounded_integer(
            sheet.get("frameHeight"),
            &format!("{path}.frameHeight"),
            1,
            frame,
        );
        let columns =
            self.bounded_integer(sheet.get("columns"), &format!("{path}.columns"), 1, grid);
        let rows = self.bounded_integer(sheet.get("rows"), &format!("{path}.rows"), 1, grid);
        let frame_count = self.bounded_integer(
            sheet.get("frameCount"),
            &format!("{path}.frameCount"),
            1,
            PET_SPRITE_FRAME_COUNT_MAX,
        );
        let max = PET_SPRITE_SHEET_MAX_DIMENSION;
        if let (Some(width), Some(columns)) = (frame_width, columns)
            && width * columns > max
        {
            self.add(
                IssueCode::OutOfRange,
                path,
                format!("sprite sheet width must be at most {max} pixels"),
            );
        }
        if let (Some(height), Some(rows)) = (frame_height, rows)
            && height * rows > max
        {
            self.add(
                IssueCode::OutOfRange,
                path,
                format!("sprite sheet height must be at most {max} pixels"),
            );
        }
        if let (Some(count), Some(columns), Some(rows)) = (frame_count, columns, rows)
            && count > columns * rows
        {
            self.add(
                IssueCode::OutOfRange,
                format!("{path}.frameCount"),
                "cannot exceed the sprite grid capacity",
            );
        }
        Some(PetSpriteSheet {
            path: sprite_path?.to_owned(),
            format: format?,
            frame_width: frame_width?,
            frame_height: frame_height?,
            columns: columns?,
            rows: rows?,
            frame_count: frame_count?,
        })
    }

    /// `validateAnimation`.
    fn animation(
        &mut self,
        value: &Value,
        state: PetActivityState,
        frame_count: Option<u32>,
    ) -> Option<PetAnimation> {
        let path = format!("$.animations.{}", state.key());
        let Some(animation) = value.as_object() else {
            self.add(IssueCode::InvalidType, path, "must be an object");
            return None;
        };
        self.exact_shape(animation, &["frames", "fps", "loop"], &["fallback"], &path);

        let mut frames = Some(Vec::new());
        match animation.get("frames").and_then(Value::as_array).filter(|list| !list.is_empty()) {
            None => {
                self.add(
                    IssueCode::InvalidValue,
                    format!("{path}.frames"),
                    "must be a non-empty array",
                );
                frames = None;
            }
            Some(list) if list.len() > PET_SPRITE_FRAME_COUNT_MAX as usize => {
                self.add(
                    IssueCode::OutOfRange,
                    format!("{path}.frames"),
                    format!("must contain at most {PET_SPRITE_FRAME_COUNT_MAX} frames"),
                );
                frames = None;
            }
            Some(list) => {
                for (index, frame) in list.iter().enumerate() {
                    let in_range = as_integer(Some(frame)).filter(|frame| {
                        *frame >= 0. && frame_count.is_none_or(|count| *frame < f64::from(count))
                    });
                    match in_range {
                        // Within u32: below the frame count, or a JSON
                        // number that fits when there is none to check.
                        Some(frame) if frame <= f64::from(u32::MAX) => {
                            if let Some(frames) = &mut frames {
                                frames.push(frame as u32);
                            }
                        }
                        _ => {
                            let message = match frame_count {
                                None => "must be a non-negative integer".to_owned(),
                                Some(count) => {
                                    format!("must be an integer between 0 and {}", count - 1)
                                }
                            };
                            self.add(
                                IssueCode::OutOfRange,
                                format!("{path}.frames[{index}]"),
                                message,
                            );
                            frames = None;
                        }
                    }
                }
            }
        }

        let fps = self.bounded_integer(
            animation.get("fps"),
            &format!("{path}.fps"),
            1,
            PET_ANIMATION_FPS_MAX,
        );
        let looping = animation.get("loop").and_then(Value::as_bool);
        if looping.is_none() {
            self.add(IssueCode::InvalidType, format!("{path}.loop"), "must be a boolean");
        }

        let mut fallback = Ok(None);
        if let Some(value) = animation.get("fallback") {
            match value.as_str().and_then(PetActivityState::from_key) {
                None => {
                    self.add(
                        IssueCode::InvalidValue,
                        format!("{path}.fallback"),
                        "must name a supported activity state",
                    );
                    fallback = Err(());
                }
                Some(_) if looping == Some(true) => {
                    self.add(
                        IssueCode::InvalidValue,
                        format!("{path}.fallback"),
                        "is only valid for non-looping animations",
                    );
                    fallback = Err(());
                }
                Some(state) => fallback = Ok(Some(state)),
            }
        }

        Some(PetAnimation {
            frames: frames?,
            fps: fps?,
            looping: looping?,
            fallback: fallback.ok()?,
        })
    }

    /// `validateAnimations`.
    fn animations(
        &mut self,
        value: Option<&Value>,
        frame_count: Option<u32>,
    ) -> Option<[Option<PetAnimation>; 10]> {
        let path = "$.animations";
        let Some(animations) = value.and_then(Value::as_object) else {
            self.add(IssueCode::InvalidType, path, "must be an object");
            return None;
        };
        let mut valid = true;
        for state in PetActivityState::REQUIRED {
            if !animations.contains_key(state.key()) {
                self.add(
                    IssueCode::MissingAnimation,
                    format!("{path}.{}", state.key()),
                    format!("missing required {} animation", state.key()),
                );
                valid = false;
            }
        }
        let mut parsed: [Option<PetAnimation>; 10] = Default::default();
        for (key, animation) in animations {
            let Some(state) = PetActivityState::from_key(key) else {
                self.add(
                    IssueCode::UnknownField,
                    format!("{path}.{key}"),
                    format!("unknown activity state {key}"),
                );
                valid = false;
                continue;
            };
            match self.animation(animation, state, frame_count) {
                Some(animation) => parsed[state.index()] = Some(animation),
                None => valid = false,
            }
        }
        for (key, animation) in animations {
            let fallback = animation
                .get("fallback")
                .and_then(Value::as_str)
                .and_then(PetActivityState::from_key);
            if PetActivityState::from_key(key).is_some()
                && let Some(fallback) = fallback
                && !animations.contains_key(fallback.key())
            {
                self.add(
                    IssueCode::InvalidReference,
                    format!("{path}.{key}.fallback"),
                    format!("references missing {} animation", fallback.key()),
                );
                valid = false;
            }
        }
        valid.then_some(parsed)
    }
}

/// `validatePetPackManifest`: the manifest, or every issue with it.
pub fn validate_manifest(value: &Value) -> Result<PetPackManifest, Vec<ManifestIssue>> {
    let Some(manifest) = value.as_object() else {
        return Err(vec![ManifestIssue {
            code: IssueCode::InvalidType,
            path: "$".into(),
            message: "manifest must be an object".into(),
        }]);
    };
    let mut issues = Issues(Vec::new());
    issues.exact_shape(
        manifest,
        &["schema", "id", "displayName", "spriteSheet", "animations"],
        &["description"],
        "$",
    );
    if manifest.get("schema").and_then(Value::as_str) != Some(PET_PACK_SCHEMA_V1) {
        issues.add(IssueCode::InvalidValue, "$.schema", format!("must equal {PET_PACK_SCHEMA_V1}"));
    }
    let id =
        issues.bounded_text(manifest.get("id"), "$.id", PET_PACK_ID_MAX_CHARS).and_then(|id| {
            let parsed = PetPackId::parse(id);
            if parsed.is_none() {
                issues.add(
                    IssueCode::InvalidValue,
                    "$.id",
                    "must use lowercase ASCII letters, digits, dots, underscores, or hyphens and \
                 start and end with a letter or digit",
                );
            }
            parsed
        });
    let display_name = issues.bounded_text(
        manifest.get("displayName"),
        "$.displayName",
        PET_PACK_DISPLAY_NAME_MAX_CHARS,
    );
    let description = manifest.get("description").map(|description| {
        issues.bounded_text(Some(description), "$.description", PET_PACK_DESCRIPTION_MAX_CHARS)
    });
    let sprite_sheet = issues.sprite_sheet(manifest.get("spriteSheet"));
    let frame_count = manifest
        .get("spriteSheet")
        .and_then(|sheet| as_integer(sheet.get("frameCount")))
        .filter(|count| *count >= 1. && *count <= f64::from(PET_SPRITE_FRAME_COUNT_MAX))
        .map(|count| count as u32);
    let animations = issues.animations(manifest.get("animations"), frame_count);

    let Issues(issues) = issues;
    if !issues.is_empty() {
        return Err(issues);
    }
    match (id, display_name, description, sprite_sheet, animations) {
        (Some(id), Some(display_name), description, Some(sprite_sheet), Some(animations))
            if description.is_none_or(|text| text.is_some()) =>
        {
            Ok(PetPackManifest {
                id,
                display_name: display_name.to_owned(),
                description: description.flatten().map(str::to_owned),
                sprite_sheet,
                animations,
            })
        }
        // Every path to a missing part above recorded an issue.
        _ => Err(vec![ManifestIssue {
            code: IssueCode::InvalidValue,
            path: "$".into(),
            message: "manifest is incomplete".into(),
        }]),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// packages/core/src/__tests__/pet.test.ts's `validManifest`.
    pub(crate) fn valid_manifest() -> Value {
        json!({
            "schema": PET_PACK_SCHEMA_V1,
            "id": "likun.maodie",
            "displayName": "我的耄耋",
            "description": "A user-installed custom pet.",
            "spriteSheet": {
                "path": "assets/maodie.webp",
                "format": "webp",
                "frameWidth": 128,
                "frameHeight": 128,
                "columns": 4,
                "rows": 4,
                "frameCount": 16
            },
            "animations": {
                "idle": { "frames": [0, 1], "fps": 4, "loop": true },
                "working": { "frames": [2, 3, 4, 5], "fps": 8, "loop": true },
                "needs-input": { "frames": [6, 7], "fps": 4, "loop": true },
                "ready": { "frames": [8, 9], "fps": 8, "loop": false, "fallback": "idle" },
                "blocked": { "frames": [10, 11], "fps": 4, "loop": true },
                "swarm": { "frames": [12, 13], "fps": 12, "loop": true },
                "poke": { "frames": [14, 15], "fps": 10, "loop": false, "fallback": "idle" }
            }
        })
    }

    fn issues(value: &Value) -> Vec<ManifestIssue> {
        validate_manifest(value).expect_err("invalid")
    }

    #[test]
    fn a_good_pack_validates_and_stores_as_desktop_writes_it() {
        let manifest = validate_manifest(&valid_manifest()).expect("valid");
        assert_eq!(manifest.id().as_str(), "likun.maodie");
        assert_eq!(manifest.display_name(), "我的耄耋");
        assert_eq!(manifest.sprite_sheet().size(), (512, 512));
        assert_eq!(manifest.animation(PetActivityState::Ready).map(|a| a.looping), Some(false));
        assert!(manifest.animation(PetActivityState::Sleep).is_none());
        // What the library writes reads back as the same manifest, in
        // Desktop's key order.
        let stored = manifest.to_stored_json();
        assert!(
            stored.starts_with("{\n  \"schema\": \"maka.pet/v1\",\n  \"id\": \"likun.maodie\",")
        );
        assert!(stored.ends_with("}\n"));
        let reread: Value = serde_json::from_str(&stored).expect("json");
        assert_eq!(validate_manifest(&reread).expect("valid"), manifest);
        assert_eq!(
            reread["animations"]["ready"],
            json!({"frames": [8, 9], "fps": 8, "loop": false, "fallback": "idle"})
        );
    }

    #[test]
    fn each_required_animation_is_required() {
        for state in PetActivityState::REQUIRED {
            let mut manifest = valid_manifest();
            manifest["animations"].as_object_mut().expect("animations").remove(state.key());
            let path = format!("$.animations.{}", state.key());
            assert!(
                issues(&manifest).contains(&ManifestIssue {
                    code: IssueCode::MissingAnimation,
                    path,
                    message: format!("missing required {} animation", state.key()),
                }),
                "{state:?}"
            );
        }
        // An optional one may be left out.
        let mut manifest = valid_manifest();
        manifest["animations"].as_object_mut().expect("animations").remove("swarm");
        assert!(validate_manifest(&manifest).is_ok());
    }

    #[test]
    fn executable_or_unknown_fields_are_refused() {
        let mut manifest = valid_manifest();
        manifest["script"] = json!("pet.js");
        manifest["animations"]["onClick"] = json!({"command": "rm -rf ."});
        let unknown: Vec<String> = issues(&manifest)
            .into_iter()
            .filter(|issue| issue.code == IssueCode::UnknownField)
            .map(|issue| issue.path)
            .collect();
        assert_eq!(unknown, ["$.script", "$.animations.onClick"]);
    }

    #[test]
    fn traversal_absolute_windows_and_unnormalized_paths_are_refused() {
        for path in [
            "../maodie.webp",
            "/tmp/maodie.webp",
            "C:\\tmp\\maodie.webp",
            "assets\\maodie.webp",
            "assets//maodie.webp",
            "./assets/maodie.webp",
            " assets/maodie.webp",
            "assets/maodie.webp\u{feff}",
        ] {
            assert!(!is_safe_asset_path(path), "{path}");
            let mut manifest = valid_manifest();
            manifest["spriteSheet"]["path"] = json!(path);
            assert!(
                issues(&manifest).iter().any(|issue| issue.code == IssueCode::UnsafePath),
                "{path}"
            );
        }
        let mut manifest = valid_manifest();
        manifest["spriteSheet"]["path"] = json!("assets/maodie.png");
        assert!(issues(&manifest).iter().any(
            |issue| issue.path == "$.spriteSheet.path" && issue.message == "must end in .webp"
        ));
        assert!(is_safe_asset_path("assets/Sheet.WEBP"));
    }

    #[test]
    fn geometry_rate_and_frames_are_bounded() {
        let mut manifest = valid_manifest();
        manifest["spriteSheet"]["frameCount"] = json!(17);
        manifest["animations"]["idle"]["frames"] = json!([17]);
        manifest["animations"]["idle"]["fps"] = json!(61);
        let found = issues(&manifest);
        let at = |path: &str| found.iter().find(|issue| issue.path == path).map(|i| i.code);
        assert_eq!(at("$.spriteSheet.frameCount"), Some(IssueCode::OutOfRange));
        assert_eq!(at("$.animations.idle.frames[0]"), Some(IssueCode::OutOfRange));
        assert_eq!(at("$.animations.idle.fps"), Some(IssueCode::OutOfRange));

        // An fps of 60 is the ceiling; a fractional one is not an integer.
        let mut manifest = valid_manifest();
        manifest["animations"]["working"]["fps"] = json!(60);
        assert!(validate_manifest(&manifest).is_ok());
        manifest["animations"]["working"]["fps"] = json!(7.5);
        assert!(issues(&manifest).iter().any(|issue| issue.path == "$.animations.working.fps"
            && issue.code == IssueCode::InvalidType));
        // A whole number written with a point is an integer, as in JavaScript.
        manifest["animations"]["working"]["fps"] = json!(8.0);
        assert!(validate_manifest(&manifest).is_ok());
    }

    #[test]
    fn a_sheet_larger_than_the_limit_is_refused() {
        let mut manifest = valid_manifest();
        manifest["spriteSheet"]["frameWidth"] = json!(2048);
        manifest["spriteSheet"]["columns"] = json!(5);
        manifest["spriteSheet"]["frameHeight"] = json!(2049);
        let found = issues(&manifest);
        assert!(found.contains(&ManifestIssue {
            code: IssueCode::OutOfRange,
            path: "$.spriteSheet".into(),
            message: "sprite sheet width must be at most 8192 pixels".into(),
        }));
        assert!(found.iter().any(|issue| issue.path == "$.spriteSheet.frameHeight"));
    }

    #[test]
    fn fallbacks_must_exist_and_only_end_non_looping_animations() {
        let mut manifest = valid_manifest();
        manifest["animations"]["ready"]["fallback"] = json!("sleep");
        assert!(issues(&manifest).iter().any(|issue| issue.code == IssueCode::InvalidReference
            && issue.path == "$.animations.ready.fallback"));

        let mut manifest = valid_manifest();
        manifest["animations"]["idle"]["fallback"] = json!("working");
        assert!(issues(&manifest).iter().any(|issue| issue.path == "$.animations.idle.fallback"
            && issue.message == "is only valid for non-looping animations"));
    }

    #[test]
    fn identity_text_is_trimmed_bounded_and_canonical() {
        for (field, value, code) in [
            ("id", json!("Maodie"), IssueCode::InvalidValue),
            ("id", json!("-maodie"), IssueCode::InvalidValue),
            ("id", json!(7), IssueCode::InvalidType),
            ("displayName", json!(" padded"), IssueCode::InvalidValue),
            ("displayName", json!("tab\tname"), IssueCode::InvalidValue),
            ("displayName", json!("x".repeat(81)), IssueCode::OutOfRange),
            ("description", json!(null), IssueCode::InvalidType),
        ] {
            let mut manifest = valid_manifest();
            manifest[field] = value;
            let path = format!("$.{field}");
            assert!(
                issues(&manifest).iter().any(|issue| issue.path == path && issue.code == code),
                "{field}"
            );
        }
        // Length is counted as JavaScript counts it, in UTF-16 units: 80
        // two-unit characters are too long.
        let mut manifest = valid_manifest();
        manifest["displayName"] = json!("😺".repeat(41));
        assert!(issues(&manifest).iter().any(|issue| issue.path == "$.displayName"));
        manifest["displayName"] = json!("😺".repeat(40));
        assert!(validate_manifest(&manifest).is_ok());
        assert!(issues(&json!([])).iter().any(|issue| issue.path == "$"));
        assert!(
            issues(&json!({"schema": "maka.pet/v2"})).iter().any(|issue| issue.path == "$.schema")
        );
    }

    #[test]
    fn ids_are_canonical_and_sort_as_desktop_lists_them() {
        for id in ["a", "likun.maodie", "cat_2-b", &"a".repeat(64)] {
            assert_eq!(PetPackId::parse(id).map(|id| id.to_string()), Some(id.to_owned()));
        }
        for id in ["", ".a", "a.", "A", "a/b", "a b", &"a".repeat(65), "猫"] {
            assert_eq!(PetPackId::parse(id), None, "{id}");
        }
        let mut ids: Vec<PetPackId> = ["ab", "a.b", "a-b", "a_b", "a1"]
            .iter()
            .filter_map(|id| PetPackId::parse(id))
            .collect();
        ids.sort_by_key(PetPackId::collation_key);
        let sorted: Vec<&str> = ids.iter().map(PetPackId::as_str).collect();
        assert_eq!(sorted, ["a_b", "a-b", "a.b", "a1", "ab"]);
    }

    #[test]
    fn a_missing_state_plays_its_fallback_and_one_shots_hand_over() {
        let manifest = validate_manifest(&valid_manifest()).expect("valid");
        use PetActivityState::*;
        assert_eq!(resolve_animation_state(&manifest, Swarm), Swarm);
        assert_eq!(resolve_animation_state(&manifest, Sleep), Idle);
        assert_eq!(resolve_animation_state(&manifest, Cancelled), Idle);
        assert_eq!(resolve_animation_fallback(&manifest, Working), Working, "loops");
        assert_eq!(resolve_animation_fallback(&manifest, Ready), Idle);
        assert_eq!(resolve_animation_fallback(&manifest, Poke), Idle);
        assert_eq!(manifest.animation_for(Wake).frames, [0, 1], "idle's");

        let mut value = valid_manifest();
        value["animations"].as_object_mut().expect("animations").remove("swarm");
        value["animations"]["ready"] =
            json!({"frames": [8], "fps": 2, "loop": false, "fallback": "poke"});
        let manifest = validate_manifest(&value).expect("valid");
        assert_eq!(resolve_animation_state(&manifest, Swarm), Working);
        assert_eq!(resolve_animation_fallback(&manifest, Ready), Poke);
    }
}
