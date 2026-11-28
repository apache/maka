//! Resolves the gates of `nsh/base`'s parts (`src/main.rs`) to the parts:
//! the runner built here has every part its features have. `nsh package`
//! links the same objects again, pointing the gates of the parts an app
//! does not import at `nsh_part_none` instead (#1644).

/// The parts with a gate, and the feature each needs (`None`: always built).
const PARTS: &[(&str, Option<&str>)] = &[
    ("menu", None),
    ("overlays", None),
    ("select", None),
    ("command", None),
    ("combobox", None),
    ("toast", None),
    ("pickers", None),
    ("color_picker", None),
    ("emoji_picker", Some("EMOJI_PICKER")),
    ("carousel", None),
    ("tree", None),
    ("fields", None),
    ("text_view", None),
    ("editor", Some("EDITOR")),
    ("diff", Some("EDITOR")),
    ("rich_editor", Some("RICH_EDITOR")),
    ("data_table", None),
    ("table", None),
    ("dock", None),
    ("resizable", None),
    ("plot", Some("PLOT")),
    ("term", Some("TERM")),
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_WINDOWS").is_err() {
        return;
    }
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    for (part, feature) in PARTS {
        if feature.is_some_and(|f| std::env::var_os(format!("CARGO_FEATURE_{f}")).is_none()) {
            continue;
        }
        let alias = format!("nsh_part_{part}=nsh_have_{part}");
        if msvc {
            println!("cargo:rustc-link-arg-bins=/ALTERNATENAME:{alias}");
        } else {
            println!("cargo:rustc-link-arg-bins=-Wl,-Xlink=-alternatename:{alias}");
        }
    }
}
