//! GPUI Kit's theme as NSH's: the host's theme for its embedded apps.
//!
//! NSH's theme has shadcn/ui's tokens, and GPUI Kit's colors have the same
//! roles under its own names, so the conversion maps each of shadcn's
//! tokens to the GPUI Kit color of its role, as GPUI Kit resolved it (with
//! its fallbacks), so the embedded components match the host's widgets
//! exactly. It runs again on every change of the host's theme or mode, so
//! both appearances take the current mode's colors.

use gpui_kit::{
    Hsla,
    component::{Theme, ThemeMode},
};
use nsh_platform_gpui::{AdaptiveColor, Appearance};

/// A GPUI color as NSH's: the same `Hsla`, channel for channel.
fn color(c: Hsla) -> nsh_platform_gpui::Hsla {
    nsh_platform_gpui::Hsla {
        h: c.h,
        s: c.s,
        l: c.l,
        a: c.a,
    }
}

/// The host's light or dark mode, for [`nsh_platform_gpui::AppView::set_appearance`].
pub fn appearance(mode: ThemeMode) -> Appearance {
    if mode.is_dark() {
        Appearance::Dark
    } else {
        Appearance::Light
    }
}

/// `theme` (GPUI Kit's active theme) as NSH's theme, for
/// [`nsh_platform_gpui::AppView::set_theme`].
pub fn nsh_theme(theme: &Theme) -> nsh_platform_gpui::Theme {
    let mut nsh = nsh_platform_gpui::Theme::default();
    let colors = &theme.colors;
    for (name, c) in [
        ("background", colors.background),
        ("foreground", colors.foreground),
        ("card", colors.group_box),
        ("card-foreground", colors.group_box_foreground),
        ("popover", colors.popover),
        ("popover-foreground", colors.popover_foreground),
        ("primary", colors.primary),
        ("primary-foreground", colors.primary_foreground),
        ("secondary", colors.secondary),
        ("secondary-foreground", colors.secondary_foreground),
        ("muted", colors.muted),
        ("muted-foreground", colors.muted_foreground),
        ("accent", colors.accent),
        ("accent-foreground", colors.accent_foreground),
        ("destructive", colors.danger),
        ("border", colors.border),
        ("input", colors.input),
        ("ring", colors.ring),
        ("chart-1", colors.chart_1),
        ("chart-2", colors.chart_2),
        ("chart-3", colors.chart_3),
        ("chart-4", colors.chart_4),
        ("chart-5", colors.chart_5),
        ("sidebar", colors.sidebar),
        ("sidebar-foreground", colors.sidebar_foreground),
        ("sidebar-primary", colors.sidebar_primary),
        (
            "sidebar-primary-foreground",
            colors.sidebar_primary_foreground,
        ),
        ("sidebar-accent", colors.sidebar_accent),
        (
            "sidebar-accent-foreground",
            colors.sidebar_accent_foreground,
        ),
        ("sidebar-border", colors.sidebar_border),
        ("sidebar-ring", colors.ring),
    ] {
        nsh.set_color(name, AdaptiveColor::from(color(c)));
    }
    nsh.set_number("radius", f32::from(theme.radius));
    nsh.set_font(nsh_core::element::FONT_SANS, theme.font_family.to_string());
    nsh.set_font(
        nsh_core::element::FONT_MONO,
        theme.mono_font_family.to_string(),
    );
    nsh
}

#[cfg(test)]
mod tests {
    use nsh_platform_gpui::Color;

    use super::*;

    #[test]
    fn colors_convert_to_rgba() {
        assert_eq!(
            Color::from(color(gpui_kit::rgb(0x336699).into())),
            Color(0x336699ff)
        );
        assert_eq!(
            Color::from(color(gpui_kit::transparent_black())),
            Color(0x0000_0000)
        );
    }

    #[test]
    fn the_current_modes_resolved_colors_are_shadcns_tokens() {
        let mut theme = Theme {
            mode: ThemeMode::Dark,
            radius: gpui_kit::px(6.0),
            ..Default::default()
        };
        theme.colors.primary = gpui_kit::rgb(0x7c3aed).into();
        let nsh = nsh_theme(&theme);
        assert_eq!(Color::from(nsh.primary.dark), Color(0x7c3aedff));
        // Both appearances: the host's current mode.
        assert_eq!(Color::from(nsh.primary.light), Color(0x7c3aedff));
        assert_eq!(nsh.radius, nsh_core::Points(6.0));
    }
}
