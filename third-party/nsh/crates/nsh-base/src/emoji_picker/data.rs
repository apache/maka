//! The emoji `EmojiPicker` shows: `emoji.tsv`, made by `cargo xtask
//! emoji-data` from emojibase-data (English names and keywords from CLDR),
//! read once per process. The native runtimes carry it; the web runtime
//! fetches it the first time a picker shows (`nsh-emoji.bin`,
//! [`nsh_core::runtime_data`]).

use std::sync::{Arc, OnceLock};

use nsh_core::prelude::*;
use rustc_hash::FxHashMap;

use super::{EmojiGroupId, EmojiSkinTone};

/// `emoji.tsv`, for the CLI to publish next to a web runtime.
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub const EMOJI_DATA: &str = include_str!("emoji.tsv");

/// The light skin tone modifier, which [`Emoji::light`] holds where each
/// tone goes.
const LIGHT: char = '\u{1F3FB}';

/// An Emoji version (`15.1`): what added an emoji, what a picker shows up
/// to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Version(u16, u16);

impl Version {
    /// `"15.1"`, `"16"`; `None` for anything else.
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let (major, minor) = text.trim().split_once('.').unwrap_or((text.trim(), "0"));
        Some(Self(major.parse().ok()?, minor.parse().ok()?))
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.1 {
            0 => write!(f, "{}", self.0),
            minor => write!(f, "{}.{minor}", self.0),
        }
    }
}

/// An emoji of the catalog.
#[derive(Debug)]
pub(crate) struct Emoji {
    /// The emoji, fully qualified.
    pub(crate) emoji: SharedString,
    pub(crate) group: EmojiGroupId,
    pub(crate) version: Version,
    /// Its form with the light skin tone on every person; empty when it
    /// takes no skin tone. Another tone is this with the modifier swapped
    /// (checked for every emoji when the data is made).
    light: Box<str>,
    /// Its English name.
    pub(crate) label: SharedString,
    /// English words it is also found by, besides those of its name.
    pub(crate) keywords: Box<[SharedString]>,
}

impl Emoji {
    /// Whether it takes a skin tone.
    pub(crate) fn has_skin_tones(&self) -> bool {
        !self.light.is_empty()
    }

    /// The emoji with `tone` on every person (itself when it takes none).
    pub(crate) fn with_tone(&self, tone: EmojiSkinTone) -> SharedString {
        match tone.modifier() {
            Some(modifier) if self.has_skin_tones() => self
                .light
                .replace(LIGHT, modifier.encode_utf8(&mut [0; 4]))
                .into(),
            _ => self.emoji.clone(),
        }
    }
}

/// Every emoji, in emojibase's order (groups in order, each group's
/// emoji in Unicode's).
#[derive(Debug)]
pub(crate) struct Catalog {
    pub(crate) emoji: Box<[Emoji]>,
    /// Each emoji's index by its text without variation selectors, so
    /// `✌️` and `✌` find the same (the app's recent emoji, its names).
    by_text: FxHashMap<Box<str>, u32>,
}

impl Catalog {
    /// Reads `emoji.tsv`; lines it cannot read are skipped (and logged).
    pub(crate) fn parse(text: &str) -> Self {
        let mut emoji = Vec::with_capacity(2048);
        for line in text
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
        {
            match Self::line(line) {
                Some(e) => emoji.push(e),
                None => log::warn!("EmojiPicker: an emoji line it cannot read: {line:?}"),
            }
        }
        let by_text = emoji
            .iter()
            .enumerate()
            .map(|(i, e)| (bare(&e.emoji), i as u32))
            .collect();
        Self {
            emoji: emoji.into_boxed_slice(),
            by_text,
        }
    }

    fn line(line: &str) -> Option<Emoji> {
        let mut fields = line.split('\t');
        let emoji = fields.next()?;
        let group = EmojiGroupId::of_emojibase(fields.next()?.parse().ok()?)?;
        let version = Version::parse(fields.next()?)?;
        let light = fields.next()?;
        let label = fields.next()?;
        Some(Emoji {
            emoji: emoji.to_owned().into(),
            group,
            version,
            light: light.into(),
            label: label.to_owned().into(),
            keywords: fields.map(|k| SharedString::from(k.to_owned())).collect(),
        })
    }

    /// The index of `text` (with or without variation selectors, a skin
    /// tone's form included).
    pub(crate) fn find(&self, text: &str) -> Option<usize> {
        let bare = bare(text);
        if let Some(&i) = self.by_text.get(&bare) {
            return Some(i as usize);
        }
        // A skin tone's form: its base, the modifiers taken out.
        let base: String = bare.chars().filter(|c| !is_tone(*c)).collect();
        (base.len() != bare.len())
            .then(|| self.by_text.get(base.as_str()).map(|&i| i as usize))
            .flatten()
    }
}

/// `text` without its variation selectors (U+FE0E, U+FE0F).
fn bare(text: &str) -> Box<str> {
    text.chars()
        .filter(|c| !matches!(c, '\u{FE0E}' | '\u{FE0F}'))
        .collect()
}

fn is_tone(c: char) -> bool {
    ('\u{1F3FB}'..='\u{1F3FF}').contains(&c)
}

static CATALOG: OnceLock<Catalog> = OnceLock::new();

/// The catalog once read: at once on the native runtimes, on the web once
/// [`load`] fetched it.
pub(crate) fn catalog() -> Option<&'static Catalog> {
    #[cfg(not(target_arch = "wasm32"))]
    return Some(CATALOG.get_or_init(|| Catalog::parse(EMOJI_DATA)));
    #[cfg(target_arch = "wasm32")]
    CATALOG.get()
}

/// Loads the catalog where the runtime does not carry it (the web: the
/// page's `nsh-emoji.bin`, fetched the first time), after the frame that
/// shows the picker without it. `false` when the page has none: the
/// picker shows its `loading` slot.
pub(crate) async fn load() -> bool {
    if catalog().is_some() {
        return true;
    }
    next_frame().await;
    let Some(bytes) = nsh_core::runtime_data::load("emoji").await else {
        return false;
    };
    if CATALOG.get().is_none() {
        let _ = CATALOG.set(read(bytes));
    }
    true
}

fn read(bytes: Arc<[u8]>) -> Catalog {
    match std::str::from_utf8(&bytes) {
        Ok(text) => Catalog::parse(text),
        Err(err) => {
            log::warn!("EmojiPicker: the page's emoji are no UTF-8 text: {err}");
            Catalog::parse("")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_reads_every_line() {
        let catalog = catalog().unwrap();
        let lines = EMOJI_DATA.lines().filter(|l| !l.starts_with('#')).count();
        assert_eq!(catalog.emoji.len(), lines);
        assert!(catalog.emoji.len() > 1900);
        assert_eq!(&*catalog.emoji[0].emoji, "😀");
        assert_eq!(&*catalog.emoji[0].label, "grinning face");
        assert_eq!(catalog.emoji[0].group, EmojiGroupId::SmileysEmotion);
        assert_eq!(catalog.emoji.last().unwrap().group, EmojiGroupId::Flags);
    }

    #[test]
    fn skin_tones_swap_the_modifier_on_every_person() {
        let catalog = catalog().unwrap();
        let of = |text: &str| &catalog.emoji[catalog.find(text).unwrap()];
        assert_eq!(&*of("👍").with_tone(EmojiSkinTone::Dark), "👍🏿");
        // A text-default base drops its selector.
        assert_eq!(&*of("✌️").with_tone(EmojiSkinTone::Medium), "✌🏽");
        // Both people, not the handshake between them.
        assert_eq!(
            &*of("🧑‍🤝‍🧑").with_tone(EmojiSkinTone::MediumLight),
            "🧑🏼\u{200D}🤝\u{200D}🧑🏼"
        );
        assert_eq!(&*of("😀").with_tone(EmojiSkinTone::Dark), "😀");
        assert_eq!(&*of("👍").with_tone(EmojiSkinTone::None), "👍");
        assert!(!of("😀").has_skin_tones() && of("👋").has_skin_tones());
    }

    #[test]
    fn emoji_are_found_with_or_without_selectors_and_tones() {
        let catalog = catalog().unwrap();
        let heart = catalog.find("❤️").unwrap();
        assert_eq!(catalog.find("❤"), Some(heart));
        let thumbs = catalog.find("👍").unwrap();
        assert_eq!(catalog.find("👍🏽"), Some(thumbs));
        assert_eq!(catalog.find("not an emoji"), None);
    }

    #[test]
    fn versions_compare_as_numbers() {
        assert!(Version::parse("15.1").unwrap() < Version::parse("16").unwrap());
        assert!(Version::parse("12.1").unwrap() > Version::parse("12").unwrap());
        assert_eq!(Version::parse("0.6").unwrap().to_string(), "0.6");
        assert_eq!(Version::parse("16.0").unwrap().to_string(), "16");
        assert_eq!(Version::parse("x"), None);
    }
}
