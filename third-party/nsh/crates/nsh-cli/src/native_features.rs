//! The Cargo features of a native release runner that an app needs,
//! worked out from what its bundle imports ([`linked_gates`]): `nsh
//! package` builds an app's own runner with them (#1878).

use crate::web::linked_gates;

/// A runner feature and why it is kept or left out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Choice {
    pub feature: &'static str,
    pub keep: bool,
    pub why: String,
}

/// The optional runner features and the gates ([`linked_gates`]) that
/// need each. An empty list: no import tells, so the feature is kept.
const BY_GATE: &[(&str, &[&str])] = &[
    ("shader", &["nsh_feature_shader"]),
    ("editor", &["nsh_part_editor", "nsh_part_diff"]),
    ("rich-editor", &["nsh_part_rich_editor"]),
    ("plot", &["nsh_part_plot"]),
    ("term", &["nsh_part_term"]),
    ("emoji-picker", &["nsh_part_emoji_picker"]),
    // Code blocks and formulas come with text the app shows, so any view
    // that renders Markdown or code keeps them.
    (
        "highlight",
        &[
            "nsh_part_text_view",
            "nsh_part_editor",
            "nsh_part_diff",
            "nsh_part_rich_editor",
        ],
    ),
    ("math", &["nsh_part_text_view", "nsh_part_rich_editor"]),
    ("zlib", &["nsh_std_zlib"]),
    ("crypto", &["nsh_std_crypto"]),
];

/// Features kept by the native modules an app imports by specifier.
const BY_MODULE: &[(&str, &str)] = &[("websocket", "websocket"), ("updater", "nsh/updater")];

/// Features no import tells about: an image URL or `fetch` call comes
/// from data, so nothing proves them unused.
const ALWAYS: &[(&str, &str)] = &[
    ("js", "the app has a JS bundle"),
    (
        "net",
        "`fetch` and remote images depend on data, not imports",
    ),
    ("svg", "an image's format depends on data, not imports"),
];

/// `nsh`'s exports that play sound: Linux's `sound` (GStreamer) decodes
/// and plays a `Sound`; `AudioPlayer` and `Video` play through GTK there.
const SOUND_EXPORTS: &[&str] = &["Sound"];

/// `nsh`'s exports that need Windows' `media` (Media Foundation and
/// XAudio2): sounds, players and videos all play through it.
const MEDIA_EXPORTS: &[&str] = &["Sound", "AudioPlayer", "Video"];

/// What the app's own Rust code may use that no bundle import tells
/// about ([`crate::rust_app::rust_code_use`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RustCodeUse {
    /// It may make a web view (#2377).
    pub web_view: bool,
    /// It may load a sound.
    pub sound: bool,
    /// It may load a sound, or make an audio player or a video.
    pub media: bool,
}

/// The runner features for an app whose bundle uses `uses` (`None`: not
/// analyzed, keep everything), plus `keep`, features the app names
/// itself (dynamic access, or what its own Rust code needs), and those
/// `rust`, the app's own Rust code, may need.
pub(crate) fn choose(
    uses: Option<&nsh_bundler::NativeUse>,
    keep: &[String],
    rust: RustCodeUse,
) -> Vec<Choice> {
    let gates = linked_gates(uses);
    let named = |f: &str| keep.iter().any(|k| k == f);
    let mut out = Vec::new();
    for (feature, why) in ALWAYS {
        out.push(Choice {
            feature,
            keep: true,
            why: (*why).into(),
        });
    }
    for (feature, need) in BY_GATE {
        let hit = need.iter().find(|g| gates.iter().any(|x| x == *g));
        out.push(match (hit, named(feature), uses.is_none()) {
            (_, _, true) => Choice {
                feature,
                keep: true,
                why: "the bundle was not analyzed".into(),
            },
            (Some(g), _, _) => Choice {
                feature,
                keep: true,
                why: format!("the app links `{g}`"),
            },
            (None, true, _) => Choice {
                feature,
                keep: true,
                why: "the app keeps it".into(),
            },
            (None, false, _) => Choice {
                feature,
                keep: false,
                why: "nothing reachable uses it".into(),
            },
        });
    }
    for (feature, module) in BY_MODULE {
        let imported = uses.is_none_or(|u| u.computed_import || u.imports.contains_key(*module));
        // The global `WebSocket` is the `websocket` module's native side.
        let global = *feature == "websocket" && uses.is_some_and(|u| u.global_websocket);
        out.push(if global {
            Choice {
                feature,
                keep: true,
                why: "the app may use the global `WebSocket`".into(),
            }
        } else if imported {
            Choice {
                feature,
                keep: true,
                why: format!("the app may import `{module}`"),
            }
        } else if named(feature) {
            Choice {
                feature,
                keep: true,
                why: "the app keeps it".into(),
            }
        } else {
            Choice {
                feature,
                keep: false,
                why: format!("nothing imports `{module}`"),
            }
        });
    }
    // The system libraries below: kept by what the bundle cannot tell
    // apart, else by what the bundle (`found`) or the app's Rust code
    // (`by_rust`) may use, or by `nsh.json`.
    let unknown = match uses {
        None => Some("the bundle was not analyzed"),
        Some(u) if u.computed_import => Some("the app loads modules by computed names"),
        Some(_) => None,
    };
    let why = |feature: &str, found: Option<String>, by_rust: Option<&str>| {
        unknown
            .map(str::to_owned)
            .or(found)
            .or(by_rust.map(str::to_owned))
            .or_else(|| named(feature).then(|| "the app keeps it".to_owned()))
    };
    let imports = |names: &[&str]| {
        let imported = uses.and_then(|u| u.imports.get("nsh"))?;
        let name = names.iter().find(|n| imported.has(n))?;
        Some(format!("the app imports `{name}`"))
    };
    let made = |made: bool, what: &str| made.then(|| format!("the app makes a `{what}`"));
    // A web view (Linux: WebKitGTK, a large system library) only when the
    // app may make one (#2377).
    let web_view = why(
        "webview",
        made(uses.is_some_and(|u| u.web_view), "WebView"),
        rust.web_view
            .then_some("the app's Rust code may make a web view"),
    );
    // Linux's GStreamer only when the app may load a `Sound`; GTK plays
    // `AudioPlayer` and `Video` without it.
    let sound = why(
        "sound",
        imports(SOUND_EXPORTS),
        rust.sound.then_some("the app's Rust code may load a sound"),
    );
    // Windows' Media Foundation and XAudio2 only when the app may play a
    // sound, an audio player or a video.
    let media = why(
        "media",
        imports(MEDIA_EXPORTS).or_else(|| made(uses.is_some_and(|u| u.video), "Video")),
        rust.media
            .then_some("the app's Rust code may play a sound or a video"),
    );
    for (feature, why, unused) in [
        ("webview", web_view, "nothing makes a `WebView`"),
        ("sound", sound, "nothing imports `Sound`"),
        (
            "media",
            media,
            "nothing imports `Sound` or `AudioPlayer`, or makes a `Video`",
        ),
    ] {
        out.push(Choice {
            feature,
            keep: why.is_some(),
            why: why.unwrap_or_else(|| unused.into()),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(code: &str) -> nsh_bundler::NativeUse {
        let mut uses = nsh_bundler::NativeUse::default();
        uses.add(code, |s| {
            s == "nsh" || s.starts_with("nsh/") || s == "websocket"
        });
        uses
    }

    fn web_view() -> RustCodeUse {
        RustCodeUse {
            web_view: true,
            ..Default::default()
        }
    }

    fn kept(choices: &[Choice]) -> Vec<&'static str> {
        choices
            .iter()
            .filter(|c| c.keep)
            .map(|c| c.feature)
            .collect()
    }

    #[test]
    fn a_button_app_leaves_the_large_parts_out() {
        let uses = bundle("import { Button } from 'nsh/base'; Button;");
        assert_eq!(
            kept(&choose(Some(&uses), &[], RustCodeUse::default())),
            ["js", "net", "svg"]
        );
    }

    #[test]
    fn an_import_keeps_its_feature_and_dropping_it_leaves_it_out() {
        let with = bundle("import { Editor } from 'nsh/base'; Editor;");
        let k = kept(&choose(Some(&with), &[], RustCodeUse::default()));
        assert!(k.contains(&"editor") && k.contains(&"highlight"), "{k:?}");
        let k = kept(&choose(
            Some(&bundle("import { Button } from 'nsh/base'; Button;")),
            &[],
            RustCodeUse::default(),
        ));
        assert!(!k.contains(&"editor"), "{k:?}");
    }

    #[test]
    fn text_view_keeps_highlight_and_math() {
        let k = kept(&choose(
            Some(&bundle("import { TextView } from 'nsh/base'; TextView;")),
            &[],
            RustCodeUse::default(),
        ));
        assert!(k.contains(&"highlight") && k.contains(&"math"), "{k:?}");
    }

    #[test]
    fn what_cannot_be_told_keeps_everything() {
        assert!(
            choose(None, &[], RustCodeUse::default())
                .iter()
                .all(|c| c.keep)
        );
        let k = choose(
            Some(&bundle("const m = 'nsh/' + x; import(m);")),
            &[],
            RustCodeUse::default(),
        );
        assert!(k.iter().all(|c| c.keep), "{k:?}");
    }

    #[test]
    fn the_global_websocket_keeps_websocket() {
        let uses = bundle("const ws = new WebSocket('wss://example.com'); ws;");
        assert!(uses.global_websocket);
        assert!(kept(&choose(Some(&uses), &[], RustCodeUse::default())).contains(&"websocket"));
        let uses = bundle("import { Button } from 'nsh/base'; Button;");
        assert!(!kept(&choose(Some(&uses), &[], RustCodeUse::default())).contains(&"websocket"));
    }

    #[test]
    fn modules_and_named_features_are_kept() {
        let uses = bundle("import { connect } from 'websocket'; connect;");
        let k = kept(&choose(
            Some(&uses),
            &["plot".into()],
            RustCodeUse::default(),
        ));
        assert!(
            k.contains(&"websocket") && k.contains(&"plot") && !k.contains(&"updater"),
            "{k:?}"
        );
    }

    #[test]
    fn web_view_only_when_something_makes_one() {
        let has = |c: &[Choice]| c.iter().any(|c| c.feature == "webview" && c.keep);
        let plain = bundle("import { Text } from 'nsh'; element('text');");
        assert!(!has(&choose(Some(&plain), &[], RustCodeUse::default())));
        assert!(has(&choose(Some(&plain), &[], web_view())));
        assert!(has(&choose(
            Some(&plain),
            &["webview".into()],
            RustCodeUse::default()
        )));
        assert!(has(&choose(
            Some(&bundle("element('webview', {});")),
            &[],
            RustCodeUse::default()
        )));
        assert!(has(&choose(None, &[], RustCodeUse::default())));
    }

    #[test]
    fn sound_and_media_only_when_the_app_plays_them() {
        let has = |c: &[Choice], f: &str| c.iter().any(|c| c.feature == f && c.keep);
        let none = RustCodeUse::default();
        // A button app, as sysmon's: neither GStreamer nor Media Foundation.
        let plain =
            bundle("import { Button } from 'nsh/base'; import { View } from 'nsh'; Button; View;");
        let c = choose(Some(&plain), &[], none);
        assert!(!has(&c, "sound") && !has(&c, "media"), "{c:?}");
        // `Sound` needs both.
        let c = choose(
            Some(&bundle("import { Sound } from 'nsh'; Sound.load('a.wav');")),
            &[],
            none,
        );
        assert!(has(&c, "sound") && has(&c, "media"), "{c:?}");
        // GTK plays `AudioPlayer` and `Video` on Linux: only Windows' `media`.
        for code in [
            "import { AudioPlayer } from 'nsh'; new AudioPlayer('a.mp3');",
            "import { Video } from 'nsh'; f(Video);",
            "_$element('video', { src: 'a.mp4' });",
        ] {
            let c = choose(Some(&bundle(code)), &[], none);
            assert!(!has(&c, "sound") && has(&c, "media"), "{code}: {c:?}");
        }
        // A namespace used whole may load a sound.
        let c = choose(
            Some(&bundle("import * as n from 'nsh'; use(n);")),
            &[],
            none,
        );
        assert!(has(&c, "sound") && has(&c, "media"), "{c:?}");
        // What cannot be told, the app's Rust code and `nsh.json` keep them.
        for c in [
            choose(None, &[], none),
            choose(Some(&bundle("import(name);")), &[], none),
            choose(
                Some(&plain),
                &[],
                RustCodeUse {
                    sound: true,
                    media: true,
                    ..Default::default()
                },
            ),
            choose(Some(&plain), &["sound".into(), "media".into()], none),
        ] {
            assert!(has(&c, "sound") && has(&c, "media"), "{c:?}");
        }
        let c = choose(
            Some(&plain),
            &[],
            RustCodeUse {
                media: true,
                ..Default::default()
            },
        );
        assert!(!has(&c, "sound") && has(&c, "media"), "{c:?}");
    }
}
