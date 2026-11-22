//! Tailwind's default palette as typed colors (`palette::SKY.shade(500)` is
//! `sky-500`): the same values Tailwind classes resolve to, independent of
//! the app's Tailwind theme, as the typed styles' scales are. Theme colors
//! ([`super::Theme`]) stay the components' first choice; the palette is
//! for what a theme does not name (illustrations, charts, demos).

use crate::{
    color::{Hsla, black, white},
    style::Color,
    tailwind::palette::{PALETTE, SHADES},
};

/// One of Tailwind's colors, in its shades 50 to 950.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Hue(u8);

impl Hue {
    /// Shade `shade`: 50, 100, 200, ..., 900 or 950 (Tailwind's
    /// `sky-500`); another number takes the nearest of them.
    pub fn shade(self, shade: u16) -> Hsla {
        let i = SHADES
            .iter()
            .enumerate()
            .min_by_key(|(_, s)| s.abs_diff(shade))
            .map_or(0, |(i, _)| i);
        Color(PALETTE[self.0 as usize].1[i]).into()
    }

    /// Its Tailwind name (`"sky"`).
    pub fn name(self) -> &'static str {
        PALETTE[self.0 as usize].0
    }
}

macro_rules! hues {
    ($($(#[$doc:meta])* $name:ident = $index:literal),* $(,)?) => {
        $($(#[$doc])* pub const $name: Hue = Hue($index);)*

        /// Every hue, in Tailwind's order.
        pub const HUES: [Hue; 26] = [$($name),*];
    };
}

hues! {
    /// `red`.
    RED = 0,
    /// `orange`.
    ORANGE = 1,
    /// `amber`.
    AMBER = 2,
    /// `yellow`.
    YELLOW = 3,
    /// `lime`.
    LIME = 4,
    /// `green`.
    GREEN = 5,
    /// `emerald`.
    EMERALD = 6,
    /// `teal`.
    TEAL = 7,
    /// `cyan`.
    CYAN = 8,
    /// `sky`.
    SKY = 9,
    /// `blue`.
    BLUE = 10,
    /// `indigo`.
    INDIGO = 11,
    /// `violet`.
    VIOLET = 12,
    /// `purple`.
    PURPLE = 13,
    /// `fuchsia`.
    FUCHSIA = 14,
    /// `pink`.
    PINK = 15,
    /// `rose`.
    ROSE = 16,
    /// `slate`.
    SLATE = 17,
    /// `gray`.
    GRAY = 18,
    /// `zinc`.
    ZINC = 19,
    /// `neutral`.
    NEUTRAL = 20,
    /// `stone`.
    STONE = 21,
    /// `mauve`.
    MAUVE = 22,
    /// `olive`.
    OLIVE = 23,
    /// `mist`.
    MIST = 24,
    /// `taupe`.
    TAUPE = 25,
}

/// `white`.
pub const WHITE: Hsla = white();

/// `black`.
pub const BLACK: Hsla = black();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hues_are_tailwinds_colors() {
        let names: Vec<&str> = HUES.iter().map(|h| h.name()).collect();
        let palette: Vec<&str> = PALETTE.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, palette);
        let theme = crate::tailwind::Theme::default();
        for hue in HUES {
            for shade in SHADES {
                assert_eq!(
                    Some(Color::from(hue.shade(shade))),
                    theme.color(&format!("{}-{shade}", hue.name())),
                );
            }
        }
        assert_eq!(SKY.shade(480), SKY.shade(500));
        assert_eq!(theme.color("white"), Some(WHITE.into()));
        assert_eq!(theme.color("black"), Some(BLACK.into()));
    }
}
