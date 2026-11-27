//! The release runner with `nsh/base` (all of `nsh/base`).
//!
//! On Windows each part of `nsh/base` but the core is reached only through
//! its gate, an external `nsh_part_<name>` the linker resolves (#1644):
//! this build points every gate at the part ([`build.rs`](../build.rs)),
//! and `nsh package` links the same objects again with the gates of the
//! parts an app does not import pointed at [`nsh_part_none`]. The linker
//! then drops those parts' code, as if the runner were compiled without them.

// A windowed program: no console opens with it.
#![windows_subsystem = "windows"]

fn main() -> std::process::ExitCode {
    // Runs any app's JS: every part of `nsh/base` it may import.
    #[cfg(windows)]
    nsh_platform_windows::set_ui_sets(vec![parts::registry()]);
    nsh_windows_app::main()
}

#[cfg(windows)]
mod parts {
    use nsh_core::element::Registry;

    /// The gate of a part the link leaves out.
    #[unsafe(no_mangle)]
    fn nsh_part_none(_: &mut Registry) {}

    macro_rules! gates {
        ($($(#[$cfg:meta])* $name:ident => $gate:ident / $have:ident,)*) => {
            unsafe extern "Rust" {
                $($(#[$cfg])* fn $gate(registry: &mut Registry);)*
            }

            $(
            /// The part itself, which its gate resolves to when it is linked.
            $(#[$cfg])*
            #[unsafe(no_mangle)]
            fn $have(registry: &mut Registry) {
                nsh_base::parts::$name(registry);
            }
            )*

            /// `nsh/base` with the parts this link has.
            pub(crate) fn registry() -> Registry {
                let parts: &[nsh_base::parts::Part] = &[
                    nsh_base::parts::core,
                    $(
                    $(#[$cfg])*
                    // SAFETY: the linker resolves the gate to the part's
                    // `nsh_have_*` or to `nsh_part_none`, both of this type.
                    |r: &mut Registry| unsafe { $gate(r) },
                    )*
                ];
                nsh_base::registry_of(parts.iter().copied())
            }
        };
    }

    gates!(
        menu => nsh_part_menu / nsh_have_menu,
        overlays => nsh_part_overlays / nsh_have_overlays,
        select => nsh_part_select / nsh_have_select,
        command => nsh_part_command / nsh_have_command,
        combobox => nsh_part_combobox / nsh_have_combobox,
        toast => nsh_part_toast / nsh_have_toast,
        pickers => nsh_part_pickers / nsh_have_pickers,
        color_picker => nsh_part_color_picker / nsh_have_color_picker,
        #[cfg(feature = "emoji-picker")] emoji_picker => nsh_part_emoji_picker / nsh_have_emoji_picker,
        carousel => nsh_part_carousel / nsh_have_carousel,
        tree => nsh_part_tree / nsh_have_tree,
        fields => nsh_part_fields / nsh_have_fields,
        text_view => nsh_part_text_view / nsh_have_text_view,
        #[cfg(feature = "editor")] editor => nsh_part_editor / nsh_have_editor,
        #[cfg(feature = "editor")] diff => nsh_part_diff / nsh_have_diff,
        #[cfg(feature = "rich-editor")] rich_editor => nsh_part_rich_editor / nsh_have_rich_editor,
        data_table => nsh_part_data_table / nsh_have_data_table,
        table => nsh_part_table / nsh_have_table,
        dock => nsh_part_dock / nsh_have_dock,
        resizable => nsh_part_resizable / nsh_have_resizable,
        #[cfg(feature = "plot")] plot => nsh_part_plot / nsh_have_plot,
        #[cfg(feature = "term")] term => nsh_part_term / nsh_have_term,
    );
}
