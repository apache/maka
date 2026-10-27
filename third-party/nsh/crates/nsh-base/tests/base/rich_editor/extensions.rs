//! Extensions (Tiptap's layer) on the state alone: the starter kit as
//! extensions makes the starter editor, `configure` leaves parts out and
//! configures them, an app's extension adds a type, a shortcut and a
//! command, priority orders keymaps, `extend` replaces parts, and
//! `Mod-Shift-b` quotes while `Mod-b` bolds.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use nsh_base::rich_editor::{
    commands::{CommandFactory, command, tiptap},
    extensions::{Extension, ExtensionManager, kit, starter},
    model::{MarkSpec, ParseRule},
    state::{EditorState, EditorStateConfig, KeyEvent, TextSelection},
};
use serde_json::{Value, json};

/// An editor state of `manager`'s schema and plugins, holding a paragraph
/// of `text` with `from..to` selected.
fn state(manager: &ExtensionManager, text: &str, from: usize, to: usize) -> EditorState {
    let schema = manager.schema().clone();
    let doc = schema
        .node_from_json(&json!({"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
        ]}))
        .unwrap();
    let state = EditorState::create(
        EditorStateConfig::new(schema)
            .doc(doc)
            .plugins(manager.plugins()),
    )
    .unwrap();
    let mut tr = state.tr();
    tr.set_selection(TextSelection::create(state.doc(), from, Some(to)));
    state.apply(tr).unwrap()
}

/// A press of `key` with Ctrl as the platform's command key (and Shift
/// when `shift`), as the editor's plugins take it: the state after, or
/// `None` when no plugin handled it.
fn press(state: &EditorState, key: &str, shift: bool, alt: bool) -> Option<EditorState> {
    let mut event = KeyEvent::new(key);
    event.mod_key = true;
    event.ctrl = true;
    event.shift = shift;
    event.alt = alt;
    let mut out = None;
    let handled = state.plugins().iter().any(|plugin| {
        plugin.handle_key_down(state, &event, &mut |tr| {
            out = Some(tr);
        })
    });
    handled.then(|| match out {
        Some(tr) => state.apply(tr).unwrap(),
        None => state.clone(),
    })
}

fn starter_manager() -> ExtensionManager {
    ExtensionManager::with_core(vec![kit::starter_kit()]).unwrap()
}

#[test]
fn the_starter_kit_makes_the_starter_editor() {
    let manager = starter_manager();
    let names = |schema: &nsh_base::rich_editor::model::Schema| {
        let mut names: Vec<String> = schema
            .node_types()
            .iter()
            .map(|t| t.name().to_owned())
            .collect();
        names.extend(schema.mark_types().iter().map(|t| t.name().to_owned()));
        names
    };
    assert_eq!(names(manager.schema()), names(&starter::schema()));
    for command in [
        "toggleBold",
        "toggleHeading",
        "toggleBulletList",
        "toggleCodeBlock",
        "setTextAlign",
        "setHardBreak",
        "setLink",
    ] {
        assert!(manager.commands().contains(command), "{command}");
    }
    // As many plugins as `starter::plugins` makes.
    assert_eq!(
        manager.plugins().len(),
        starter::plugins(manager.schema()).len()
    );
}

#[test]
fn mod_shift_b_quotes_and_mod_b_bolds() {
    let manager = starter_manager();
    let quoted = press(&state(&manager, "Hello", 1, 6), "B", true, false).unwrap();
    assert_eq!(quoted.doc().child(0).ty().name(), "blockquote");
    assert!(quoted.doc().child(0).child(0).child(0).marks().is_empty());
    // Some platforms report the key lowercase with Shift held.
    let quoted = press(&state(&manager, "Hello", 1, 6), "b", true, false).unwrap();
    assert_eq!(quoted.doc().child(0).ty().name(), "blockquote");
    let bold = press(&state(&manager, "Hello", 1, 6), "b", false, false).unwrap();
    assert_eq!(bold.doc().child(0).ty().name(), "paragraph");
    assert_eq!(bold.doc().child(0).child(0).marks()[0].ty().name(), "bold");
}

#[test]
fn configure_leaves_out_and_configures() {
    let kit = kit::starter_kit().configure(json!({
        "bold": false,
        "heading": { "levels": [1, 2] },
    }));
    let manager = ExtensionManager::with_core(vec![kit]).unwrap();
    assert!(manager.schema().mark_type("bold").is_none());
    let state = state(&manager, "Title", 1, 1);
    let run = |name: &str, args: Value| {
        let command = manager
            .commands()
            .make(name, &args, manager.schema())
            .unwrap();
        let mut out = None;
        command(&state, Some(&mut |tr| out = Some(tr))).then(|| state.apply(out.unwrap()).unwrap())
    };
    assert!(run("toggleHeading", json!({"level": 3})).is_none());
    let heading = run("toggleHeading", json!({"level": 2})).unwrap();
    assert_eq!(heading.doc().child(0).ty().name(), "heading");
    assert_eq!(heading.doc().child(0).attrs()["level"], json!(2));
    // Mod-Alt-3 is no shortcut either.
    assert!(
        press(&state, "3", false, true).is_none_or(|s| s.doc().child(0).ty().name() != "heading")
    );
}

/// An app's extension: a `shout` mark, `Mod-Alt-s` toggling it, and a
/// `toggleShout` command.
fn shout() -> Extension {
    Extension::mark("shout", |_| {
        let mut spec = MarkSpec::default();
        spec.parse_dom = vec![ParseRule::tag("strong.shout")];
        spec
    })
    .add_keyboard_shortcuts(|cx| {
        let ty = cx.schema.mark_type("shout").unwrap();
        vec![(
            "Mod-Alt-s".into(),
            tiptap::toggle_mark(ty, Default::default(), false),
        )]
    })
    .add_commands(|_| {
        let factory: CommandFactory = Arc::new(|_, schema| {
            let ty = schema.mark_type("shout").ok_or("no shout")?;
            Ok(tiptap::toggle_mark(ty, Default::default(), false))
        });
        vec![("toggleShout".into(), factory)]
    })
}

#[test]
fn an_apps_extension_adds_a_type_a_shortcut_and_a_command() {
    let manager = ExtensionManager::with_core(vec![kit::starter_kit(), shout()]).unwrap();
    assert!(manager.schema().mark_type("shout").is_some());
    let shouted = press(&state(&manager, "Hey", 1, 4), "s", false, true).unwrap();
    assert_eq!(
        shouted.doc().child(0).child(0).marks()[0].ty().name(),
        "shout"
    );
    assert!(manager.commands().contains("toggleShout"));
}

#[test]
fn priority_and_order_decide_which_binding_runs_first() {
    let runs = Arc::new(AtomicUsize::new(0));
    let bind = |name: &'static str, n: usize| {
        let runs = runs.clone();
        Extension::new(name).add_keyboard_shortcuts(move |_| {
            let runs = runs.clone();
            vec![(
                "Mod-k".into(),
                command(move |_, _| {
                    runs.fetch_add(n, Ordering::Relaxed);
                    true
                }),
            )]
        })
    };
    // A later extension binds before an earlier one of its priority.
    let manager =
        ExtensionManager::with_core(vec![kit::starter_kit(), bind("one", 1), bind("two", 10)])
            .unwrap();
    press(&state(&manager, "a", 1, 1), "k", false, false).unwrap();
    assert_eq!(runs.swap(0, Ordering::Relaxed), 10);
    // A higher priority binds first wherever it is.
    let manager = ExtensionManager::with_core(vec![
        kit::starter_kit(),
        bind("one", 1).with_priority(1000),
        bind("two", 10),
    ])
    .unwrap();
    press(&state(&manager, "a", 1, 1), "k", false, false).unwrap();
    assert_eq!(runs.swap(0, Ordering::Relaxed), 1);
}

#[test]
fn extend_replaces_parts() {
    let bold = kit::bold().extend().add_keyboard_shortcuts(|cx| {
        let ty = cx.schema.mark_type("bold").unwrap();
        vec![(
            "Mod-Alt-b".into(),
            tiptap::toggle_mark(ty, Default::default(), false),
        )]
    });
    let manager = ExtensionManager::with_core(vec![
        kit::starter_kit().configure(json!({ "bold": false })),
        bold,
    ])
    .unwrap();
    let start = state(&manager, "Hello", 1, 6);
    assert!(press(&start, "b", false, false).is_none());
    let bold = press(&start, "b", false, true).unwrap();
    assert_eq!(bold.doc().child(0).child(0).marks()[0].ty().name(), "bold");
    // Its commands stay.
    assert!(manager.commands().contains("toggleBold"));
}

#[test]
fn duplicate_extensions_are_refused() {
    assert!(ExtensionManager::with_core(vec![kit::starter_kit(), kit::bold()]).is_err());
}
