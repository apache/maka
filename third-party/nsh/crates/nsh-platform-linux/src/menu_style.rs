//! The look of GTK's menus (`gtk::PopoverMenu`: context menus and the menu
//! bar's), in the app's colors: a style sheet made from the app's design
//! tokens ([`css`]), loaded again when they change
//! ([`nsh_core::Command::Tokens`]). The menus stay GTK's own; their colors,
//! sizes and indicators are NSH's (gpui-base's popover and menu), so they
//! look the same under every GTK theme.
//!
//! The tokens are shadcn/ui's, as `nsh-base`'s theme names them:
//! `popover` and `popover-foreground` (the menu and its labels), `accent`
//! and `accent-foreground` (the item under the pointer or the keyboard),
//! `muted-foreground` (shortcuts, disabled items) and `border` (the menu's
//! edge, separators). A token the app does not have takes the default
//! theme's value. Light values apply to every menu, dark ones to the menus
//! of a surface in dark appearance (`.nsh-dark` on the root, around its
//! context menus, and on the menu bar's slot).
//!
//! The indicators are drawn by the style sheet itself rather than taken
//! from the icon theme (Yaru's submenu arrow is a hairline glyph): a
//! chevron and a check are two sides of a box turned 45°, a radio's dot a
//! round box, in the label's color. Images in a GTK style sheet load
//! through gdk-pixbuf's loaders, which may not read SVG, so no image is
//! used.
//!
//! A menu's items sit in a scrolled window, which is never shorter than its
//! vertical scrollbar, shown or not. GTK's theme gives the slider 40px (44
//! with its margins), more than a menu of one item (40), which then had
//! more room below its item than above; a shorter slider keeps the
//! scrollbar out of the menu's height.

use nsh_core::{Hsla, Rgba, element::Tokens};

/// The default theme's colors (`nsh-base`'s, neutral): `(token, light,
/// dark)`.
const DEFAULTS: [(&str, u32, u32); 6] = [
    ("popover", 0xffffff, 0x0a0a0a),
    ("popover-foreground", 0x0a0a0a, 0xfafafa),
    ("accent", 0xf5f5f5, 0x262626),
    ("accent-foreground", 0x171717, 0xfafafa),
    ("muted-foreground", 0x737373, 0xa3a3a3),
    ("border", 0xe5e5e5, 0x262626),
];

/// The menus' style sheet for `tokens`.
pub(crate) fn css(tokens: &Tokens) -> String {
    let mut out = String::from(SHAPE);
    for dark in [false, true] {
        let scope = if dark { ".nsh-dark " } else { "" };
        let color = |name: &str| {
            let (_, light, night) = DEFAULTS.iter().find(|(n, ..)| *n == name).unwrap();
            let fallback = if dark { *night } else { *light };
            tokens
                .color(name)
                .map(|c| css_color(if dark { c.dark } else { c.light }))
                .unwrap_or_else(|| format!("#{fallback:06x}"))
        };
        let (popover, foreground) = (color("popover"), color("popover-foreground"));
        let (accent, accent_foreground) = (color("accent"), color("accent-foreground"));
        let (muted, border) = (color("muted-foreground"), color("border"));
        out.push_str(&format!(
            "
{scope}popover.menu > contents {{ background-color: {popover}; color: {foreground}; border-color: {border}; }}
{scope}popover.menu modelbutton {{ color: {foreground}; }}
{scope}popover.menu modelbutton:hover, {scope}popover.menu modelbutton:selected {{ background-color: {accent}; color: {accent_foreground}; }}
{scope}popover.menu modelbutton accelerator, {scope}popover.menu modelbutton:disabled {{ color: {muted}; }}
{scope}popover.menu separator {{ background-color: {border}; }}
"
        ));
    }
    out
}

/// What does not depend on the colors.
const SHAPE: &str = "
popover.menu { padding: 0; }
popover.menu > contents {
  padding: 4px; border-radius: 8px; border: 1px solid; background-image: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  font-size: 13px;
}
popover.menu modelbutton {
  min-height: 28px; padding: 0 8px; border-radius: 6px;
  background-image: none; background-color: transparent; box-shadow: none; outline: none;
}
popover.menu modelbutton:disabled { filter: none; opacity: 1; }
popover.menu modelbutton accelerator { margin-left: 24px; }
popover.menu separator { min-height: 1px; margin: 4px -4px; }
popover.menu > contents > scrolledwindow > scrollbar.vertical > range > trough > slider { min-height: 16px; }
popover.menu modelbutton check, popover.menu modelbutton radio, popover.menu modelbutton arrow {
  -gtk-icon-source: none; background-image: none; background-color: transparent;
  border: 0 solid currentColor; border-radius: 0; box-shadow: none; outline: none;
  min-width: 14px; min-height: 14px; margin: 0; padding: 0;
}
popover.menu modelbutton check, popover.menu modelbutton radio { margin-right: 8px; }
popover.menu modelbutton check:checked {
  min-width: 4px; min-height: 8px; margin: 1px 12px 3px 4px;
  border-width: 0 2px 2px 0; transform: rotate(45deg);
}
popover.menu modelbutton radio:checked {
  min-width: 6px; min-height: 6px; margin: 4px 12px 4px 4px;
  border-radius: 9999px; background-color: currentColor;
}
popover.menu modelbutton arrow.right {
  min-width: 4px; min-height: 4px; margin: 4px 6px 4px 10px;
  border-width: 2px 2px 0 0; transform: rotate(45deg);
}
popover.menu modelbutton arrow.left {
  min-width: 4px; min-height: 4px; margin: 4px 10px 4px 6px;
  border-width: 0 0 2px 2px; transform: rotate(45deg);
}
";

fn css_color(color: Hsla) -> String {
    let Rgba { r, g, b, a } = color.into();
    let byte = |v: f32| (v * 255.0).round() as u8;
    format!("rgba({}, {}, {}, {})", byte(r), byte(g), byte(b), a)
}

#[cfg(test)]
mod tests {
    use gtk4::{self as gtk, gdk, gio, prelude::*};
    use nsh_core::element::{AdaptiveColor, Tokens};

    use super::css;

    /// The style sheet takes the app's colors, the default theme's where
    /// it has none, and GTK reads every rule of it (where a display can be
    /// opened).
    #[test]
    fn menu_style_follows_the_tokens_and_parses() {
        let mut tokens = Tokens::default();
        tokens.set_color("accent", AdaptiveColor::rgb(0xff0000, 0x0000ff));
        let sheet = css(&tokens);
        assert!(sheet.contains(
            "popover.menu modelbutton:hover, popover.menu modelbutton:selected { \
             background-color: rgba(255, 0, 0, 1);"
        ));
        assert!(sheet.contains(".nsh-dark popover.menu modelbutton:hover"));
        assert!(sheet.contains("background-color: rgba(0, 0, 255, 1)"));
        assert!(sheet.contains("background-color: #ffffff; color: #0a0a0a"));
        crate::gtk_test::run(move || {
            let provider = gtk::CssProvider::new();
            let errors = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
            let seen = errors.clone();
            provider.connect_parsing_error(move |_, section, error| {
                seen.borrow_mut()
                    .push(format!("{}: {error}", section.to_str()));
            });
            provider.load_from_string(&sheet);
            assert!(errors.borrow().is_empty(), "{:?}", errors.borrow());
        });
    }

    /// A menu of one item is as tall as the item: the scrolled window
    /// around the items is not held taller by its vertical scrollbar.
    #[test]
    fn one_item_menu_fits_its_item() {
        crate::gtk_test::run(|| {
            let display = gdk::Display::default().expect("a display");
            let provider = gtk::CssProvider::new();
            provider.load_from_string(&css(&Tokens::default()));
            gtk::style_context_add_provider_for_display(
                &display,
                &provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
            let model = gio::Menu::new();
            model.append(Some("New folder"), Some("app.new-folder"));
            let menu = gtk::PopoverMenu::from_model(Some(&model));
            let scrolled = scrolled_window(menu.upcast_ref()).expect("the menu's scrolled window");
            // The window takes its items' natural height
            // (`propagate-natural-height`), unless its scrollbar needs more.
            let (_, window, ..) = scrolled.measure(gtk::Orientation::Vertical, -1);
            let (_, items, ..) = scrolled
                .child()
                .expect("the items")
                .measure(gtk::Orientation::Vertical, -1);
            gtk::style_context_remove_provider_for_display(&display, &provider);
            assert_eq!(window, items);
        });
    }

    fn scrolled_window(widget: &gtk::Widget) -> Option<gtk::ScrolledWindow> {
        if let Some(scrolled) = widget.downcast_ref::<gtk::ScrolledWindow>() {
            return Some(scrolled.clone());
        }
        let mut child = widget.first_child();
        while let Some(widget) = child {
            if let Some(found) = scrolled_window(&widget) {
                return Some(found);
            }
            child = widget.next_sibling();
        }
        None
    }
}
