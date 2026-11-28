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
//! used. The indicators are GTK's built-in icons, which are never smaller
//! than their `-gtk-icon-size` (16px unless the theme says otherwise), so
//! each box sets it to its own width: a check or chevron as wide as it is
//! tall was a square, which turned 45° is a "V".
//!
//! A menu's items sit in a scrolled window, which is never shorter than its
//! vertical scrollbar, shown or not. GTK's theme gives the slider 40px (44
//! with its margins), more than a menu of one item (40), which then had
//! more room below its item than above; a shorter slider keeps the
//! scrollbar out of the menu's height.

use nsh_core::{Hsla, Rgba, element::Tokens};

/// The default theme's colors (`nsh-base`'s, neutral): `(token, light,
/// dark)`.
const DEFAULTS: [(&str, u32, u32); 8] = [
    ("background", 0xffffff, 0x0a0a0a),
    ("foreground", 0x0a0a0a, 0xfafafa),
    ("popover", 0xffffff, 0x0a0a0a),
    ("popover-foreground", 0x0a0a0a, 0xfafafa),
    ("accent", 0xf5f5f5, 0x262626),
    ("accent-foreground", 0x171717, 0xfafafa),
    ("muted-foreground", 0x737373, 0xa3a3a3),
    ("border", 0xe5e5e5, 0x262626),
];

/// The menus' and root surfaces' style sheet for `tokens`.
pub(crate) fn css(tokens: &Tokens) -> String {
    let mut out = String::from(SHAPE);
    for dark in [false, true] {
        let scope = if dark { ".nsh-dark " } else { "" };
        let root_class = if dark { ".nsh-dark" } else { ".nsh-light" };
        let color = |name: &str| {
            let (_, light, night) = DEFAULTS.iter().find(|(n, ..)| *n == name).unwrap();
            let fallback = if dark { *night } else { *light };
            tokens
                .color(name)
                .map(|c| css_color(if dark { c.dark } else { c.light }))
                .unwrap_or_else(|| format!("#{fallback:06x}"))
        };
        let background = color("background");
        let (popover, foreground) = (color("popover"), color("popover-foreground"));
        let (accent, accent_foreground) = (color("accent"), color("accent-foreground"));
        let (muted, border) = (color("muted-foreground"), color("border"));
        let text = color("foreground");
        let controls = if dark {
            "windowcontrols.nsh-on-dark"
        } else {
            "windowcontrols.nsh-on-light"
        };
        out.push_str(&format!(
            "
{root_class} {{ background-color: {background}; }}
{scope}popover.menu > contents, {root_class} text popover > contents, {root_class} textview popover > contents {{ background-color: {popover}; color: {foreground}; border-color: {border}; }}
{root_class} text popover > arrow, {root_class} textview popover > arrow {{ background-color: {popover}; border-color: {border}; }}
{scope}popover.menu modelbutton, {root_class} text popover modelbutton, {root_class} textview popover modelbutton {{ color: {foreground}; }}
{scope}popover.menu modelbutton:hover, {scope}popover.menu modelbutton:selected {{ background-color: {accent}; color: {accent_foreground}; }}
{root_class} text popover modelbutton:hover, {root_class} text popover modelbutton:selected, {root_class} textview popover modelbutton:hover, {root_class} textview popover modelbutton:selected {{ background-color: {accent}; color: {accent_foreground}; }}
{scope}popover.menu modelbutton accelerator, {scope}popover.menu modelbutton:disabled, {root_class} text popover modelbutton accelerator, {root_class} text popover modelbutton:disabled, {root_class} textview popover modelbutton accelerator, {root_class} textview popover modelbutton:disabled {{ color: {muted}; }}
{scope}popover.menu separator, {root_class} text popover separator, {root_class} textview popover separator {{ background-color: {border}; }}
{controls} button {{ color: {text}; }}
{controls} button:hover {{ background-color: {accent}; color: {accent_foreground}; }}
"
        ));
    }
    out
}

/// What does not depend on the colors.
const SHAPE: &str = "
popover.menu, .nsh-light text popover.background, .nsh-dark text popover.background, .nsh-light textview popover.background, .nsh-dark textview popover.background { padding: 0; }
popover.menu > contents, .nsh-light text popover.background > contents, .nsh-dark text popover.background > contents, .nsh-light textview popover.background > contents, .nsh-dark textview popover.background > contents {
  padding: 4px; border-radius: 8px; border: 1px solid; background-image: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  font-size: 13px;
}
popover.menu modelbutton, .nsh-light text popover modelbutton, .nsh-dark text popover modelbutton, .nsh-light textview popover modelbutton, .nsh-dark textview popover modelbutton {
  min-height: 28px; padding: 0 8px; border-radius: 6px;
  background-image: none; background-color: transparent; box-shadow: none; outline: none;
}
popover.menu modelbutton:disabled, .nsh-light text popover modelbutton:disabled, .nsh-dark text popover modelbutton:disabled, .nsh-light textview popover modelbutton:disabled, .nsh-dark textview popover modelbutton:disabled { filter: none; opacity: 1; }
popover.menu modelbutton accelerator, .nsh-light text popover modelbutton accelerator, .nsh-dark text popover modelbutton accelerator, .nsh-light textview popover modelbutton accelerator, .nsh-dark textview popover modelbutton accelerator { margin-left: 24px; }
popover.menu separator { min-height: 1px; min-width: 8px; margin: 4px -4px; }
.nsh-light text popover separator, .nsh-dark text popover separator, .nsh-light textview popover separator, .nsh-dark textview popover separator { min-height: 1px; min-width: 1px; margin: 4px 0; }
popover.menu > contents > scrolledwindow > scrollbar.vertical > range > trough > slider { min-height: 16px; }
popover.menu modelbutton check, popover.menu modelbutton radio, popover.menu modelbutton arrow {
  -gtk-icon-source: none; background-image: none; background-color: transparent;
  border: 0 solid currentColor; border-radius: 0; box-shadow: none; outline: none;
  min-width: 14px; min-height: 14px; -gtk-icon-size: 14px; margin: 0; padding: 0;
}
popover.menu modelbutton check, popover.menu modelbutton radio { margin-right: 8px; }
popover.menu modelbutton check:checked {
  min-width: 4px; min-height: 8px; -gtk-icon-size: 4px; margin: 1px 12px 3px 4px;
  border-width: 0 2px 2px 0; transform: rotate(45deg);
}
popover.menu modelbutton radio:checked {
  min-width: 6px; min-height: 6px; -gtk-icon-size: 6px; margin: 4px 12px 4px 4px;
  border-radius: 9999px; background-color: currentColor;
}
popover.menu modelbutton arrow.right {
  min-width: 4px; min-height: 4px; -gtk-icon-size: 4px; margin: 4px 6px 4px 10px;
  border-width: 2px 2px 0 0; transform: rotate(45deg);
}
popover.menu modelbutton arrow.left {
  min-width: 4px; min-height: 4px; -gtk-icon-size: 4px; margin: 4px 10px 4px 6px;
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
    use gtk4::{self as gtk, gdk, gio, glib, prelude::*};
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

    /// The window buttons over a hidden title bar take the surface's
    /// foreground, not a theme's title bar one: Yaru gives them white
    /// glyphs, invisible on a light app (#3381).
    #[test]
    fn window_controls_follow_the_surface() {
        crate::gtk_test::run(|| {
            let display = gdk::Display::default().expect("a display");
            let theme = gtk::CssProvider::new();
            theme.load_from_string("windowcontrols button { color: #ffffff; }");
            gtk::style_context_add_provider_for_display(
                &display,
                &theme,
                gtk::STYLE_PROVIDER_PRIORITY_THEME,
            );
            let provider = gtk::CssProvider::new();
            provider.load_from_string(&css(&Tokens::default()));
            gtk::style_context_add_provider_for_display(
                &display,
                &provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
            let controls = gtk::WindowControls::new(gtk::PackType::End);
            controls.set_decoration_layout(Some(":close"));
            let window = gtk::Window::new();
            window.set_child(Some(&controls));
            let color = |dark: bool| {
                crate::window::controls_scheme(&controls, dark);
                let button = controls.first_child().expect("the close button");
                let c = button.color();
                (c.red(), c.green(), c.blue())
            };
            let light = color(false);
            let dark = color(true);
            gtk::style_context_remove_provider_for_display(&display, &provider);
            gtk::style_context_remove_provider_for_display(&display, &theme);
            let near = |a: (f32, f32, f32), b: f32| {
                (a.0 - b).abs() < 0.01 && (a.1 - b).abs() < 0.01 && (a.2 - b).abs() < 0.01
            };
            assert!(near(light, 10.0 / 255.0), "{light:?}");
            assert!(near(dark, 250.0 / 255.0), "{dark:?}");
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

    /// The indicators are the size of their boxes, not of the theme's
    /// icons: a check, a radio and a submenu's arrow, set or not, take the
    /// same width, so the labels line up, and the check is taller than it
    /// is wide (it was a square, drawn as a "V").
    #[test]
    fn indicators_take_their_boxes_size() {
        crate::gtk_test::run(|| {
            let display = gdk::Display::default().expect("a display");
            let provider = gtk::CssProvider::new();
            provider.load_from_string(&css(&Tokens::default()));
            gtk::style_context_add_provider_for_display(
                &display,
                &provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
            let actions = gio::SimpleActionGroup::new();
            for (name, on) in [("on", true), ("off", false)] {
                actions.add_action(&gio::SimpleAction::new_stateful(
                    name,
                    None,
                    &on.to_variant(),
                ));
            }
            actions.add_action(&gio::SimpleAction::new_stateful(
                "pick",
                Some(glib::VariantTy::STRING),
                &"a".to_variant(),
            ));
            let model = gio::Menu::new();
            model.append(Some("Checked"), Some("t.on"));
            model.append(Some("Unchecked"), Some("t.off"));
            model.append(Some("Picked"), Some("t.pick::a"));
            model.append(Some("Not picked"), Some("t.pick::b"));
            model.append_submenu(Some("More"), &gio::Menu::new());
            let menu = gtk::PopoverMenu::from_model(Some(&model));
            menu.insert_action_group("t", Some(&actions));
            let mut indicators = Vec::new();
            collect(menu.upcast_ref(), &mut indicators);
            gtk::style_context_remove_provider_for_display(&display, &provider);
            let names: Vec<_> = indicators.iter().map(|(name, ..)| name.as_str()).collect();
            // The submenu's arrow, and the arrow back on its page.
            assert_eq!(
                names,
                ["check", "check", "radio", "radio", "arrow", "arrow"]
            );
            // Each as wide as an unchecked check: 14px and its 8px margin.
            for (name, checked, width, _) in &indicators {
                assert_eq!(*width, 22, "{name} (checked: {checked})");
            }
            // The checked check: 8px, a 2px border and 1 + 3px margins.
            assert_eq!((indicators[0].1, indicators[0].3), (true, 14));
        });
    }

    #[test]
    fn root_surface_and_text_edit_popovers_follow_tokens_and_parse() {
        let mut tokens = Tokens::default();
        tokens.set_color("background", AdaptiveColor::rgb(0xf8fafc, 0x101318));
        tokens.set_color("popover", AdaptiveColor::rgb(0xf1f5f9, 0x181c24));
        tokens.set_color("popover-foreground", AdaptiveColor::rgb(0x0f172a, 0xe2e8f0));
        tokens.set_color("accent", AdaptiveColor::rgb(0xe2e8f0, 0x263042));
        tokens.set_color("accent-foreground", AdaptiveColor::rgb(0x020617, 0xf8fafc));
        tokens.set_color("border", AdaptiveColor::rgb(0xcbd5e1, 0x303946));
        let sheet = css(&tokens);
        assert!(sheet.contains(".nsh-light { background-color: rgba(248, 250, 252, 1); }"));
        assert!(sheet.contains(".nsh-dark { background-color: rgba(16, 19, 24, 1); }"));
        assert!(sheet.contains(
            ".nsh-light text popover > contents, .nsh-light textview popover > contents { \
             background-color: rgba(241, 245, 249, 1);"
        ));
        assert!(sheet.contains(
            ".nsh-dark text popover modelbutton:hover, .nsh-dark text popover modelbutton:selected, \
             .nsh-dark textview popover modelbutton:hover, .nsh-dark textview popover modelbutton:selected { \
             background-color: rgba(38, 48, 66, 1);"
        ));
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

    /// Separators reserve enough `min-width` to offset their negative `-4px`
    /// horizontal margins so GTK 4.22+ does not report a negative minimum
    /// width when measuring them.
    #[test]
    fn separator_reports_non_negative_min_width() {
        let sheet = css(&Tokens::default());
        assert!(sheet.contains(
            "popover.menu separator { min-height: 1px; min-width: 8px; margin: 4px -4px; }"
        ));
        crate::gtk_test::run(|| {
            static INIT: std::sync::Once = std::sync::Once::new();
            static CAPTURE: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            static WARNINGS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
            INIT.call_once(|| {
                glib::log_set_writer_func(|level, fields| {
                    if CAPTURE.load(std::sync::atomic::Ordering::Acquire)
                        && level == glib::LogLevel::Warning
                    {
                        let domain = fields
                            .iter()
                            .find(|f| f.key() == "GLIB_DOMAIN")
                            .and_then(|f| f.value_str());
                        let message = fields
                            .iter()
                            .find(|f| f.key() == "MESSAGE")
                            .and_then(|f| f.value_str())
                            .unwrap_or("");
                        if domain == Some("Gtk") {
                            WARNINGS.lock().unwrap().push(message.to_string());
                        }
                    }
                    glib::log_writer_default(level, fields)
                });
            });
            struct Guard;
            impl Drop for Guard {
                fn drop(&mut self) {
                    CAPTURE.store(false, std::sync::atomic::Ordering::Release);
                }
            }
            WARNINGS.lock().unwrap().clear();
            CAPTURE.store(true, std::sync::atomic::Ordering::Release);
            let _guard = Guard;
            let display = gdk::Display::default().expect("a display");
            let provider = gtk::CssProvider::new();
            provider.load_from_string(&css(&Tokens::default()));
            gtk::style_context_add_provider_for_display(
                &display,
                &provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
            let actions = gio::SimpleActionGroup::new();
            actions.add_action(&gio::SimpleAction::new("cut", None));
            actions.add_action(&gio::SimpleAction::new("paste", None));
            let first = gio::Menu::new();
            first.append(Some("Cut"), Some("t.cut"));
            let second = gio::Menu::new();
            second.append(Some("Paste"), Some("t.paste"));
            let model = gio::Menu::new();
            model.append_section(None, &first);
            model.append_section(None, &second);
            let window = gtk::Window::new();
            let menu = gtk::PopoverMenu::from_model(Some(&model));
            menu.insert_action_group("t", Some(&actions));
            menu.set_parent(&window);
            window.present();
            menu.popup();
            assert!(
                crate::gtk_test::wait_until(|| has_separator(menu.upcast_ref())),
                "expected a menu separator widget"
            );
            let mut separators = Vec::new();
            collect_separators(menu.upcast_ref(), &mut separators);
            menu.popdown();
            menu.unparent();
            window.destroy();
            gtk::style_context_remove_provider_for_display(&display, &provider);
            drop(_guard);
            let warnings = std::mem::take(&mut *WARNINGS.lock().unwrap());
            assert!(warnings.is_empty(), "unexpected Gtk warnings: {warnings:?}");
            assert!(!separators.is_empty(), "expected a menu separator widget");
            for (min_w, min_h) in separators {
                assert!(min_w >= 0, "separator min width was {min_w}");
                assert!(min_h >= 1, "separator min height was {min_h}");
            }
        });
    }

    fn has_separator(widget: &gtk::Widget) -> bool {
        if widget.css_name() == "separator" {
            return true;
        }
        let mut child = widget.first_child();
        while let Some(widget) = child {
            if has_separator(&widget) {
                return true;
            }
            child = widget.next_sibling();
        }
        false
    }

    fn collect_separators(widget: &gtk::Widget, out: &mut Vec<(i32, i32)>) {
        if widget.css_name() == "separator" {
            let (min_w, ..) = widget.measure(gtk::Orientation::Horizontal, -1);
            let (min_h, ..) = widget.measure(gtk::Orientation::Vertical, -1);
            out.push((min_w, min_h));
        }
        let mut child = widget.first_child();
        while let Some(widget) = child {
            collect_separators(&widget, out);
            child = widget.next_sibling();
        }
    }
    /// Each indicator's name, whether it is set, and its width and height.
    fn collect(widget: &gtk::Widget, out: &mut Vec<(String, bool, i32, i32)>) {
        let name = widget.css_name();
        if ["check", "radio", "arrow"].contains(&name.as_str()) {
            let checked = widget.state_flags().contains(gtk::StateFlags::CHECKED);
            let (width, ..) = widget.measure(gtk::Orientation::Horizontal, -1);
            let (height, ..) = widget.measure(gtk::Orientation::Vertical, -1);
            out.push((name.to_string(), checked, width, height));
        }
        let mut child = widget.first_child();
        while let Some(widget) = child {
            collect(&widget, out);
            child = widget.next_sibling();
        }
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
