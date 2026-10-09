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

//! The app icon, as Maka Desktop has it: its shipped set (`APP_ICONS` in
//! packages/core/src/settings.ts, the art in apps/desktop/assets/), icons a
//! person imports (custom-app-icons.ts and custom-app-icon-store.ts:
//! centre-cropped square, scaled to 1024 px, kept as `<id>.png` in the
//! client's own `app-icons` directory), a separate choice for dark
//! appearance, and the Dock showing the choice for the appearance the app
//! is in (app-icon-surface.ts, client-settings-effects.ts).
//!
//! The choice is a client preference ([`crate::Preferences`]); applying it
//! to the Dock is the shell's platform call, which [`install_app_icons`]
//! takes as a [`DockIconSink`], so this crate stays free of AppKit.

use std::fs;
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, OnceLock};

use gpui_kit::{
    App, AppContext as _, Context, Entity, Global, Image, ImageFormat, RenderImage, Subscription,
    Task,
};
use image::{DynamicImage, ImageDecoder as _, ImageReader};
use serde::{Deserialize, Serialize};
use shared::copy::Text;
use shared::copy::appearance as copy;

use crate::preferences::{AppPreferences, theme_mode};

macro_rules! app_icons {
    ($($variant:ident = $id:literal, $label:ident, $help:ident;)*) => {
        /// One of Maka Desktop's shipped icons, by its id in `APP_ICONS`.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum AppIcon {
            $($variant,)*
        }

        impl AppIcon {
            /// Every shipped icon, in `APP_ICONS` order.
            pub const ALL: &[Self] = &[$(Self::$variant,)*];

            /// The id Desktop's settings file names it by.
            pub fn id(self) -> &'static str {
                match self {
                    $(Self::$variant => $id,)*
                }
            }

            /// The icon's name and one-line description in the picker.
            pub fn copy(self) -> (Text, Text) {
                match self {
                    $(Self::$variant => (copy::$label, copy::$help),)*
                }
            }

            /// The 1024 px art the Dock shows.
            pub fn art(self) -> &'static [u8] {
                match self {
                    $(Self::$variant => include_bytes!(concat!("../../../assets/app-icons/", $id, ".png")),)*
                }
            }

            /// The picker's 128 px thumbnail (Desktop's `PREVIEW_SIZE`).
            fn thumbnail_bytes(self) -> &'static [u8] {
                match self {
                    $(Self::$variant => include_bytes!(concat!("../../../assets/app-icons/thumbnails/", $id, ".png")),)*
                }
            }
        }
    };
}

app_icons! {
    Default = "default", ICON_DEFAULT, ICON_DEFAULT_HELP;
    Mono = "mono", ICON_MONO, ICON_MONO_HELP;
    Sky = "sky", ICON_SKY, ICON_SKY_HELP;
    Cyan = "cyan", ICON_CYAN, ICON_CYAN_HELP;
    Ice = "ice", ICON_ICE, ICON_ICE_HELP;
    PaleInverted = "pale-inverted", ICON_PALE_INVERTED, ICON_PALE_INVERTED_HELP;
    Ink = "ink", ICON_INK, ICON_INK_HELP;
    Paper = "paper", ICON_PAPER, ICON_PAPER_HELP;
    Graphite = "graphite", ICON_GRAPHITE, ICON_GRAPHITE_HELP;
    PencilKraft = "pencil-kraft", ICON_PENCIL_KRAFT, ICON_PENCIL_KRAFT_HELP;
    PencilSky = "pencil-sky", ICON_PENCIL_SKY, ICON_PENCIL_SKY_HELP;
    PencilNavy = "pencil-navy", ICON_PENCIL_NAVY, ICON_PENCIL_NAVY_HELP;
    Alpine = "alpine", ICON_ALPINE, ICON_ALPINE_HELP;
    Dusk = "dusk", ICON_DUSK, ICON_DUSK_HELP;
    Night = "night", ICON_NIGHT, ICON_NIGHT_HELP;
    Forest = "forest", ICON_FOREST, ICON_FOREST_HELP;
    Midnight = "midnight", ICON_MIDNIGHT, ICON_MIDNIGHT_HELP;
    Carbon = "carbon", ICON_CARBON, ICON_CARBON_HELP;
    Slate = "slate", ICON_SLATE, ICON_SLATE_HELP;
    Obsidian = "obsidian", ICON_OBSIDIAN, ICON_OBSIDIAN_HELP;
    NeonCyan = "neon-cyan", ICON_NEON_CYAN, ICON_NEON_CYAN_HELP;
    Matrix = "matrix", ICON_MATRIX, ICON_MATRIX_HELP;
    Magenta = "magenta", ICON_MAGENTA, ICON_MAGENTA_HELP;
    AmberCrt = "amber-crt", ICON_AMBER_CRT, ICON_AMBER_CRT_HELP;
    Clay = "clay", ICON_CLAY, ICON_CLAY_HELP;
    Sage = "sage", ICON_SAGE, ICON_SAGE_HELP;
    Dust = "dust", ICON_DUST, ICON_DUST_HELP;
    Fog = "fog", ICON_FOG, ICON_FOG_HELP;
    Sunset = "sunset", ICON_SUNSET, ICON_SUNSET_HELP;
    Amber = "amber", ICON_AMBER, ICON_AMBER_HELP;
    Terracotta = "terracotta", ICON_TERRACOTTA, ICON_TERRACOTTA_HELP;
    Ocean = "ocean", ICON_OCEAN, ICON_OCEAN_HELP;
    Moss = "moss", ICON_MOSS, ICON_MOSS_HELP;
    Desert = "desert", ICON_DESERT, ICON_DESERT_HELP;
    Glacier = "glacier", ICON_GLACIER, ICON_GLACIER_HELP;
    Gold = "gold", ICON_GOLD, ICON_GOLD_HELP;
    Chrome = "chrome", ICON_CHROME, ICON_CHROME_HELP;
    MonoBlack = "mono-black", ICON_MONO_BLACK, ICON_MONO_BLACK_HELP;
    MonoWhite = "mono-white", ICON_MONO_WHITE, ICON_MONO_WHITE_HELP;
    Hazard = "hazard", ICON_HAZARD, ICON_HAZARD_HELP;
}

impl AppIcon {
    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|icon| icon.id() == id)
    }

    /// The thumbnail as an image GPUI decodes and caches, made once.
    pub fn thumbnail(self) -> Arc<Image> {
        static THUMBNAILS: OnceLock<Vec<Arc<Image>>> = OnceLock::new();
        let thumbnails = THUMBNAILS.get_or_init(|| {
            Self::ALL
                .iter()
                .map(|icon| {
                    Arc::new(Image::from_bytes(ImageFormat::Png, icon.thumbnail_bytes().to_vec()))
                })
                .collect()
        });
        let index = Self::ALL.iter().position(|icon| *icon == self).unwrap_or_default();
        thumbnails[index].clone()
    }
}

/// `DEFAULT_APP_ICON`: what a fresh install shows.
pub const DEFAULT_APP_ICON: AppIcon = AppIcon::Sky;
/// `DEFAULT_APP_ICON_DARK`: what the dark slot starts on when the split is
/// turned on.
pub const DEFAULT_APP_ICON_DARK: AppIcon = AppIcon::Ink;

/// The picker's groups (`APP_ICON_GROUPS` in appearance-settings-page.tsx):
/// the brand pair, then the one drawing recoloured, by what the colour
/// does. Imported icons follow as their own group.
pub const APP_ICON_GROUPS: [(&str, Text, &[AppIcon]); 12] = {
    use AppIcon::*;
    [
        ("mascot", copy::GROUP_MASCOT, &[Default, Mono]),
        ("blue", copy::GROUP_BLUE, &[Sky, Cyan, Ice, PaleInverted]),
        ("contrast", copy::GROUP_CONTRAST, &[Ink, Paper, Graphite]),
        ("pencil", copy::GROUP_PENCIL, &[PencilKraft, PencilSky, PencilNavy]),
        ("mountain", copy::GROUP_MOUNTAIN, &[Alpine, Dusk, Night, Forest]),
        ("dark", copy::GROUP_DARK, &[Midnight, Carbon, Slate, Obsidian]),
        ("neon", copy::GROUP_NEON, &[NeonCyan, Matrix, Magenta, AmberCrt]),
        ("muted", copy::GROUP_MUTED, &[Clay, Sage, Dust, Fog]),
        ("warm", copy::GROUP_WARM, &[Sunset, Amber, Terracotta]),
        ("nature", copy::GROUP_NATURE, &[Ocean, Moss, Desert, Glacier]),
        ("metal", copy::GROUP_METAL, &[Gold, Chrome]),
        ("highContrast", copy::GROUP_HIGH_CONTRAST, &[MonoBlack, MonoWhite, Hazard]),
    ]
};

/// An imported icon's id: 32 lowercase hex digits, the whole of its file
/// name, so nothing but a well-formed id ever reaches a path.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CustomIconId([u8; 16]);

impl CustomIconId {
    pub fn parse(hex: &str) -> Option<Self> {
        let bytes = hex.as_bytes();
        if bytes.len() != 32
            || !bytes.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return None;
        }
        let nibble = |b: u8| if b.is_ascii_digit() { b - b'0' } else { b - b'a' + 10 };
        let mut id = [0; 16];
        for (ix, pair) in bytes.chunks(2).enumerate() {
            id[ix] = (nibble(pair[0]) << 4) | nibble(pair[1]);
        }
        Some(Self(id))
    }

    fn random() -> Self {
        Self(*uuid::Uuid::new_v4().as_bytes())
    }

    pub fn hex(&self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

impl std::fmt::Debug for CustomIconId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CustomIconId({})", self.hex())
    }
}

/// `CUSTOM_APP_ICON_PREFIX`.
const CUSTOM_PREFIX: &str = "custom:";

/// What the Dock shows (`AppIconChoice`): a shipped icon, or an imported
/// one, referred to as `custom:<id>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AppIconChoice {
    Shipped(AppIcon),
    Custom(CustomIconId),
}

impl AppIconChoice {
    /// `isAppIconChoice`: a shipped id, or `custom:` and 32 hex digits.
    pub fn parse(value: &str) -> Option<Self> {
        match value.strip_prefix(CUSTOM_PREFIX) {
            Some(hex) => CustomIconId::parse(hex).map(Self::Custom),
            None => AppIcon::from_id(value).map(Self::Shipped),
        }
    }

    /// The value as the settings file records it.
    pub fn key(&self) -> String {
        match self {
            Self::Shipped(icon) => icon.id().to_owned(),
            Self::Custom(id) => format!("{CUSTOM_PREFIX}{}", id.hex()),
        }
    }
}

impl std::default::Default for AppIconChoice {
    fn default() -> Self {
        Self::Shipped(DEFAULT_APP_ICON)
    }
}

impl From<AppIcon> for AppIconChoice {
    fn from(icon: AppIcon) -> Self {
        Self::Shipped(icon)
    }
}

impl Serialize for AppIconChoice {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.key())
    }
}

impl<'de> Deserialize<'de> for AppIconChoice {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| serde::de::Error::custom("not an app icon"))
    }
}

/// Which appearance a selection is for (`AppIconTarget`). `Both` is one
/// icon everywhere: it clears the dark slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppIconTarget {
    Both,
    Light,
    Dark,
}

/// `appIconForTheme`: the light choice, or the dark one while the app is
/// dark and one is set.
pub fn app_icon_for_theme(
    light: AppIconChoice,
    dark: Option<AppIconChoice>,
    is_dark: bool,
) -> AppIconChoice {
    match dark {
        Some(dark) if is_dark => dark,
        _ => light,
    }
}

/// `CUSTOM_ICON_EDGE`: every imported icon is stored this size.
pub const CUSTOM_ICON_EDGE: u32 = 1024;
/// `CUSTOM_ICON_MIN_EDGE`.
pub const CUSTOM_ICON_MIN_EDGE: u32 = 128;
/// `CUSTOM_ICON_MAX_EDGE`.
pub const CUSTOM_ICON_MAX_EDGE: u32 = 4096;
/// `CUSTOM_ICON_MAX_INPUT_BYTES`.
pub const CUSTOM_ICON_MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;
/// The edge of an imported icon's picker thumbnail.
const THUMBNAIL_EDGE: u32 = 128;

/// Why an import failed (`CustomAppIconImportReason`, less `cancelled`,
/// which is the file dialog's answer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconImportFailure {
    TooLarge,
    TooManyPixels,
    UnsupportedFormat,
    Unreadable,
    TooSmall,
    WriteFailed,
}

impl IconImportFailure {
    /// Desktop's words for it (`appIconImportFailed`).
    pub fn text(self) -> Text {
        match self {
            Self::TooLarge => copy::APP_ICON_TOO_LARGE,
            Self::TooManyPixels => copy::APP_ICON_TOO_MANY_PIXELS,
            Self::UnsupportedFormat => copy::APP_ICON_UNSUPPORTED_FORMAT,
            Self::Unreadable => copy::APP_ICON_UNREADABLE,
            Self::TooSmall => copy::APP_ICON_TOO_SMALL,
            Self::WriteFailed => copy::APP_ICON_WRITE_FAILED,
        }
    }
}

/// `readImageHeader`: a PNG's or a baseline or progressive JPEG's format
/// and size, from its bytes, before any decoder allocates for them.
fn image_header(bytes: &[u8]) -> Option<(image::ImageFormat, u32, u32)> {
    png_header(bytes).or_else(|| jpeg_header(bytes))
}

fn png_header(bytes: &[u8]) -> Option<(image::ImageFormat, u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let read = |at: usize| Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    Some((image::ImageFormat::Png, read(16)?, read(20)?))
}

fn jpeg_header(bytes: &[u8]) -> Option<(image::ImageFormat, u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return None;
    }
    let read =
        |at: usize| Some(u32::from(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?)));
    let mut offset = 2;
    while offset + 3 < bytes.len() {
        if bytes[offset] != 0xff {
            return None;
        }
        let marker = bytes[offset + 1];
        if marker == 0xff {
            offset += 1;
            continue;
        }
        if marker == 0xd9 || marker == 0xda {
            return None;
        }
        let length = read(offset + 2)? as usize;
        if length < 2 {
            return None;
        }
        // Start-of-frame markers carry the size; DHT, JPG, and DAC do not.
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            if offset + 9 > bytes.len() {
                return None;
            }
            return Some((image::ImageFormat::Jpeg, read(offset + 7)?, read(offset + 5)?));
        }
        offset += 2 + length;
    }
    None
}

/// Decode, square, scale (`importCustomAppIcon` less the file I/O): the
/// header is checked first, the decoded picture turned upright (EXIF),
/// centre-cropped to a square, scaled to [`CUSTOM_ICON_EDGE`], and encoded
/// as PNG.
pub fn normalize_icon(bytes: &[u8]) -> Result<Vec<u8>, IconImportFailure> {
    let (format, width, height) =
        image_header(bytes).ok_or(IconImportFailure::UnsupportedFormat)?;
    if width.max(height) > CUSTOM_ICON_MAX_EDGE {
        return Err(IconImportFailure::TooManyPixels);
    }
    if width.min(height) < CUSTOM_ICON_MIN_EDGE {
        return Err(IconImportFailure::TooSmall);
    }
    let decoded = decode_upright(bytes, format).ok_or(IconImportFailure::Unreadable)?;
    // The decoded size, not the header's: an EXIF rotation swaps them.
    let (width, height) = (decoded.width(), decoded.height());
    let edge = width.min(height);
    // `Math.round` of the half margin.
    let squared =
        decoded.crop_imm((width - edge).div_ceil(2), (height - edge).div_ceil(2), edge, edge);
    let scaled = squared.resize_exact(
        CUSTOM_ICON_EDGE,
        CUSTOM_ICON_EDGE,
        image::imageops::FilterType::CatmullRom,
    );
    let mut png = Vec::new();
    DynamicImage::ImageRgba8(scaled.into_rgba8())
        .write_to(&mut io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|_| IconImportFailure::Unreadable)?;
    if png.is_empty() {
        return Err(IconImportFailure::Unreadable);
    }
    Ok(png)
}

fn decode_upright(bytes: &[u8], format: image::ImageFormat) -> Option<DynamicImage> {
    let mut decoder =
        ImageReader::with_format(io::Cursor::new(bytes), format).into_decoder().ok()?;
    let orientation = decoder.orientation().ok()?;
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    Some(image)
}

/// The directory imported icons live in (`customAppIconDirectory`), owned
/// by this client: `app-icons` beside its preferences. Every call blocks
/// on the file system, so run it on the background executor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomIcons {
    dir: PathBuf,
}

// Every call runs on the background executor (see above).
#[allow(clippy::disallowed_methods)]
impl CustomIcons {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// `resolveCustomAppIconPath`.
    pub fn path(&self, id: CustomIconId) -> PathBuf {
        self.dir.join(format!("{}.png", id.hex()))
    }

    /// `listCustomAppIconIds`: every imported icon, oldest id first,
    /// skipping anything unrecognised.
    pub fn list(&self) -> Vec<CustomIconId> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut ids: Vec<CustomIconId> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let name = entry.file_name();
                CustomIconId::parse(name.to_str()?.strip_suffix(".png")?)
            })
            .collect();
        ids.sort_by_key(CustomIconId::hex);
        ids
    }

    /// Imports the PNG or JPEG at `source`: read once into a capped
    /// buffer, normalized, and stored under a new id.
    pub fn import(&self, source: &Path) -> Result<CustomIconId, IconImportFailure> {
        let bytes = read_capped(source)?;
        let png = normalize_icon(&bytes)?;
        let id = CustomIconId::random();
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt as _;
            builder.mode(0o700);
        }
        builder.create(&self.dir).and_then(|()| fs::write(self.path(id), png)).map_err(
            |error| {
                log::warn!("could not store an imported icon: {error}");
                IconImportFailure::WriteFailed
            },
        )?;
        Ok(id)
    }

    /// `removeCustomAppIcon`: art that is not there counts as removed.
    pub fn remove(&self, id: CustomIconId) -> io::Result<()> {
        match fs::remove_file(self.path(id)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    /// An imported icon's art.
    pub fn read(&self, id: CustomIconId) -> io::Result<Vec<u8>> {
        fs::read(self.path(id))
    }

    /// The picker's thumbnail of an imported icon; `None` when its art no
    /// longer decodes, so it drops out of the picker (Desktop's check of
    /// `nativeImage.isEmpty()`).
    pub fn thumbnail(&self, id: CustomIconId) -> Option<Arc<RenderImage>> {
        let bytes = self.read(id).ok()?;
        let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).ok()?;
        let mut small = image
            .resize_exact(THUMBNAIL_EDGE, THUMBNAIL_EDGE, image::imageops::FilterType::Triangle)
            .into_rgba8();
        for pixel in small.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
        Some(Arc::new(RenderImage::new(vec![image::Frame::new(small)])))
    }
}

/// `readCapped`: one open handle, read to its end or to the cap.
fn read_capped(path: &Path) -> Result<Vec<u8>, IconImportFailure> {
    let file = fs::File::open(path).map_err(|_| IconImportFailure::Unreadable)?;
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return Err(IconImportFailure::Unreadable);
    }
    let mut bytes = Vec::new();
    file.take(CUSTOM_ICON_MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IconImportFailure::Unreadable)?;
    if bytes.len() as u64 > CUSTOM_ICON_MAX_INPUT_BYTES {
        return Err(IconImportFailure::TooLarge);
    }
    Ok(bytes)
}

/// Puts art on the Dock: the shell's platform call, given the PNG bytes.
pub type DockIconSink = Rc<dyn Fn(AppIconChoice, &[u8], &mut App)>;

/// Where imported icons live, once the shell has said
/// ([`install_app_icons`]). Without it the picker offers only the shipped
/// set.
struct CustomIconDirectory(CustomIcons);

impl Global for CustomIconDirectory {}

/// The imported icons' directory the shell installed, if any.
pub fn custom_icons(cx: &App) -> Option<CustomIcons> {
    cx.try_global::<CustomIconDirectory>().map(|directory| directory.0.clone())
}

/// The directory imported icons live in, in the client's config directory
/// (Desktop's `<userData>/app-icons`).
pub const CUSTOM_ICON_DIRECTORY: &str = "app-icons";

/// Installs where imported icons live (none: only the shipped set is
/// offered) and starts applying the chosen icon through `dock`: now,
/// whenever the choice changes, and whenever the app's appearance flips
/// while a separate dark icon is set. Call once, after the preferences are
/// restored.
pub fn install_app_icons(
    directory: Option<PathBuf>,
    dock: DockIconSink,
    cx: &mut App,
) -> Entity<DockIcon> {
    if let Some(directory) = directory {
        cx.set_global(CustomIconDirectory(CustomIcons::new(directory)));
    }
    let entity = cx.new(|cx| DockIcon::new(dock, cx));
    cx.set_global(GlobalDockIcon(entity.clone()));
    entity
}

struct GlobalDockIcon(Entity<DockIcon>);

impl Global for GlobalDockIcon {}

/// Behavior owner of the Dock's icon (Desktop's `applyAppIcon` through
/// `createClientSettingsEffects`): it resolves the choice for the
/// appearance the app is in and applies it when that changes, and only
/// then, so an appearance flip with one icon everywhere costs nothing.
/// Imported art is read in the background; art that has gone missing
/// falls back to the brand mark (`appIconLoadOrder`).
pub struct DockIcon {
    dock: DockIconSink,
    applied: Option<AppIconChoice>,
    generation: u64,
    _load: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for DockIcon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DockIcon").field("applied", &self.applied).finish_non_exhaustive()
    }
}

impl DockIcon {
    fn new(dock: DockIconSink, cx: &mut Context<Self>) -> Self {
        let subscriptions = vec![
            cx.observe(&AppPreferences::global(cx), |this, _, cx| this.refresh(cx)),
            // An appearance flip changes no preference; the theme is where
            // it shows.
            cx.observe_global::<gpui_kit::component::Theme>(|this, cx| this.refresh(cx)),
        ];
        let mut this =
            Self { dock, applied: None, generation: 0, _load: None, _subscriptions: subscriptions };
        this.refresh(cx);
        this
    }

    /// The Dock's icon, once the shell installed one.
    pub fn global(cx: &App) -> Option<Entity<Self>> {
        cx.try_global::<GlobalDockIcon>().map(|global| global.0.clone())
    }

    /// The choice last applied.
    pub fn applied(&self) -> Option<AppIconChoice> {
        self.applied
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let preferences = AppPreferences::current(cx);
        let wanted = app_icon_for_theme(
            preferences.app_icon,
            preferences.app_icon_dark,
            theme_mode(cx).is_dark(),
        );
        if self.applied == Some(wanted) {
            return;
        }
        self.applied = Some(wanted);
        self.generation += 1;
        match wanted {
            AppIconChoice::Shipped(icon) => {
                self._load = None;
                (self.dock)(wanted, icon.art(), cx);
            }
            AppIconChoice::Custom(id) => {
                let generation = self.generation;
                let icons = custom_icons(cx);
                let read = cx.background_spawn(async move {
                    icons.map(|icons| icons.read(id)).transpose().ok().flatten()
                });
                self._load = Some(cx.spawn(async move |this, cx| {
                    let art = read.await;
                    this.update(cx, |this, cx| {
                        if this.generation != generation {
                            return;
                        }
                        match art {
                            Some(art) => (this.dock)(wanted, &art, cx),
                            None => {
                                log::warn!(
                                    "the imported app icon {id:?} is gone; showing the brand mark"
                                );
                                (this.dock)(AppIcon::Default.into(), AppIcon::Default.art(), cx);
                            }
                        }
                    })
                    .ok();
                }));
            }
        }
    }
}

#[cfg(test)]
// Test setup writes fixture files synchronously.
#[allow(clippy::disallowed_methods)]
pub(crate) mod tests {
    use super::*;

    /// Whether `pixel` is `expected` within resampling's rounding.
    fn near(pixel: [u8; 4], expected: [u8; 4]) -> bool {
        pixel.iter().zip(expected).all(|(a, b)| a.abs_diff(b) <= 3)
    }

    /// An RGBA PNG `width` by `height`: red on the left third, green in the
    /// middle, blue on the right.
    pub(crate) fn striped_png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_fn(width, height, |x, _| match x * 3 / width {
            0 => image::Rgba([255, 0, 0, 255]),
            1 => image::Rgba([0, 255, 0, 255]),
            _ => image::Rgba([0, 0, 255, 255]),
        });
        let mut png = Vec::new();
        DynamicImage::ImageRgba8(image)
            .write_to(&mut io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("png");
        png
    }

    #[test]
    fn every_shipped_icon_has_art_a_thumbnail_and_a_group() {
        assert_eq!(AppIcon::ALL.len(), 40);
        let grouped: Vec<AppIcon> =
            APP_ICON_GROUPS.iter().flat_map(|(_, _, icons)| icons.iter().copied()).collect();
        let mut sorted = grouped.clone();
        sorted.sort_by_key(|icon| AppIcon::ALL.iter().position(|each| each == icon));
        sorted.dedup();
        assert_eq!(sorted.len(), 40, "every icon in one group");
        for icon in AppIcon::ALL {
            assert!(icon.art().starts_with(b"\x89PNG"), "{icon:?}");
            let thumbnail = image::load_from_memory(icon.thumbnail_bytes()).expect("thumbnail");
            assert_eq!((thumbnail.width(), thumbnail.height()), (128, 128), "{icon:?}");
            assert_eq!(AppIcon::from_id(icon.id()), Some(*icon));
        }
    }

    #[test]
    fn choices_read_and_write_as_desktops_settings_do() {
        assert_eq!(AppIconChoice::parse("sky"), Some(AppIcon::Sky.into()));
        let id = "0123456789abcdef0123456789abcdef";
        let custom = AppIconChoice::parse(&format!("custom:{id}")).expect("custom");
        assert_eq!(custom.key(), format!("custom:{id}"));
        for bad in [
            "",
            "Sky",
            "custom:",
            "custom:0123",
            "custom:../../etc/passwd",
            &format!("custom:{}", id.to_uppercase()),
        ] {
            assert_eq!(AppIconChoice::parse(bad), None, "{bad}");
        }
        let dark = Some(AppIconChoice::from(AppIcon::Ink));
        assert_eq!(app_icon_for_theme(AppIcon::Sky.into(), dark, true), AppIcon::Ink.into());
        assert_eq!(app_icon_for_theme(AppIcon::Sky.into(), dark, false), AppIcon::Sky.into());
        assert_eq!(app_icon_for_theme(AppIcon::Sky.into(), None, true), AppIcon::Sky.into());
    }

    #[test]
    fn an_import_is_cropped_to_its_centre_and_scaled_to_1024() {
        // 600×200: the centre square is the middle third, all green.
        let png = normalize_icon(&striped_png(600, 200)).expect("normalized");
        let icon = image::load_from_memory(&png).expect("png").into_rgba8();
        assert_eq!(icon.dimensions(), (1024, 1024));
        for x in [0, 512, 1023] {
            assert!(near(icon.get_pixel(x, 512).0, [0, 255, 0, 255]), "x {x}");
        }
        // A square stays whole: its left edge is still red.
        let png = normalize_icon(&striped_png(300, 300)).expect("square");
        let icon = image::load_from_memory(&png).expect("png").into_rgba8();
        assert!(near(icon.get_pixel(0, 10).0, [255, 0, 0, 255]));
        assert!(near(icon.get_pixel(1023, 10).0, [0, 0, 255, 255]));
    }

    #[test]
    fn an_import_names_what_is_wrong_with_the_file() {
        assert_eq!(normalize_icon(&striped_png(100, 300)), Err(IconImportFailure::TooSmall));
        assert_eq!(normalize_icon(b"GIF89a......"), Err(IconImportFailure::UnsupportedFormat));
        // A PNG header claiming 5000 px is refused before anything decodes it.
        let mut huge = striped_png(200, 200);
        huge[16..20].copy_from_slice(&5000u32.to_be_bytes());
        assert_eq!(normalize_icon(&huge), Err(IconImportFailure::TooManyPixels));
        // A valid header over damaged data does not decode.
        let mut damaged = striped_png(200, 200);
        let len = damaged.len();
        damaged.truncate(len / 2);
        assert_eq!(normalize_icon(&damaged), Err(IconImportFailure::Unreadable));
        // A JPEG's size comes from its start-of-frame segment.
        let mut jpeg = Vec::new();
        DynamicImage::ImageRgb8(image::RgbImage::new(300, 150))
            .write_to(&mut io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .expect("jpeg");
        assert_eq!(image_header(&jpeg), Some((image::ImageFormat::Jpeg, 300, 150)));
        assert!(normalize_icon(&jpeg).is_ok());
    }

    #[test]
    fn imported_icons_are_stored_listed_and_removed() {
        let dir = std::env::temp_dir().join(format!("settings-icons-{}", uuid::Uuid::new_v4()));
        let icons = CustomIcons::new(dir.join("app-icons"));
        assert_eq!(icons.list(), []);
        let source = dir.join("picked.png");
        fs::create_dir_all(&dir).expect("dir");
        fs::write(&source, striped_png(256, 256)).expect("source");
        let id = icons.import(&source).expect("import");
        assert_eq!(icons.list(), [id]);
        assert!(icons.thumbnail(id).is_some());
        fs::write(dir.join("app-icons").join("notes.txt"), "x").expect("stray");
        assert_eq!(icons.list(), [id], "anything else is skipped");
        assert_eq!(icons.import(&dir.join("missing.png")), Err(IconImportFailure::Unreadable));
        icons.remove(id).expect("remove");
        icons.remove(id).expect("removing it again is success");
        assert_eq!(icons.list(), []);
        fs::remove_dir_all(dir).ok();
    }
}
