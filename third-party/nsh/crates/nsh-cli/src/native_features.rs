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

/// The runner features for an app whose bundle uses `uses` (`None`: not
/// analyzed, keep everything), plus `keep`, features the app names
/// itself (dynamic access, or what its own Rust code needs).
///
/// `rust_web_view`: the app's own Rust code may make a web view
/// ([`crate::rust_app::may_make_web_view`]).
pub(crate) fn choose(
    uses: Option<&nsh_bundler::NativeUse>,
    keep: &[String],
    rust_web_view: bool,
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
    // A web view (Linux: WebKitGTK, a large system library) only when the
    // app may make one (#2377).
    let why = match uses {
        None => Some("the bundle was not analyzed"),
        Some(u) if u.computed_import => Some("the app loads modules by computed names"),
        Some(u) if u.web_view => Some("the app makes a `WebView`"),
        _ if rust_web_view => Some("the app's Rust code may make a web view"),
        _ if named("webview") => Some("the app keeps it"),
        _ => None,
    };
    out.push(Choice {
        feature: "webview",
        keep: why.is_some(),
        why: why.unwrap_or("nothing makes a `WebView`").into(),
    });
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
        assert_eq!(kept(&choose(Some(&uses), &[], false)), ["js", "net", "svg"]);
    }

    #[test]
    fn an_import_keeps_its_feature_and_dropping_it_leaves_it_out() {
        let with = bundle("import { Editor } from 'nsh/base'; Editor;");
        let k = kept(&choose(Some(&with), &[], false));
        assert!(k.contains(&"editor") && k.contains(&"highlight"), "{k:?}");
        let k = kept(&choose(
            Some(&bundle("import { Button } from 'nsh/base'; Button;")),
            &[],
            false,
        ));
        assert!(!k.contains(&"editor"), "{k:?}");
    }

    #[test]
    fn text_view_keeps_highlight_and_math() {
        let k = kept(&choose(
            Some(&bundle("import { TextView } from 'nsh/base'; TextView;")),
            &[],
            false,
        ));
        assert!(k.contains(&"highlight") && k.contains(&"math"), "{k:?}");
    }

    #[test]
    fn what_cannot_be_told_keeps_everything() {
        assert!(choose(None, &[], false).iter().all(|c| c.keep));
        let k = choose(
            Some(&bundle("const m = 'nsh/' + x; import(m);")),
            &[],
            false,
        );
        assert!(k.iter().all(|c| c.keep), "{k:?}");
    }

    #[test]
    fn the_global_websocket_keeps_websocket() {
        let uses = bundle("const ws = new WebSocket('wss://example.com'); ws;");
        assert!(uses.global_websocket);
        assert!(kept(&choose(Some(&uses), &[], false)).contains(&"websocket"));
        let uses = bundle("import { Button } from 'nsh/base'; Button;");
        assert!(!kept(&choose(Some(&uses), &[], false)).contains(&"websocket"));
    }

    #[test]
    fn modules_and_named_features_are_kept() {
        let uses = bundle("import { connect } from 'websocket'; connect;");
        let k = kept(&choose(Some(&uses), &["plot".into()], false));
        assert!(
            k.contains(&"websocket") && k.contains(&"plot") && !k.contains(&"updater"),
            "{k:?}"
        );
    }

    #[test]
    fn web_view_only_when_something_makes_one() {
        let has = |c: &[Choice]| c.iter().any(|c| c.feature == "webview" && c.keep);
        let plain = bundle("import { Text } from 'nsh'; element('text');");
        assert!(!has(&choose(Some(&plain), &[], false)));
        assert!(has(&choose(Some(&plain), &[], true)));
        assert!(has(&choose(Some(&plain), &["webview".into()], false)));
        assert!(has(&choose(
            Some(&bundle("element('webview', {});")),
            &[],
            false
        )));
        assert!(has(&choose(None, &[], false)));
    }
}
