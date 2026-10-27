//! Key bindings, a port of `prosemirror-keymap`.
//!
//! A binding's name is a key (as [`KeyEvent::key`] names it: `"Enter"`,
//! `"a"`, `"ArrowUp"`, `"Space"` for the space bar) after modifiers
//! separated by `-`: `Shift-`, `Alt-` (`a-`), `Ctrl-` (`c-`, `Control-`),
//! `Meta-` (`Cmd-`, `m-`) and `Mod-`, which is `Meta-` on Apple platforms
//! and `Ctrl-` elsewhere. Character keys are matched with their case as
//! typed (`"Shift-a"` and `"A"` both name Shift with A held), as in
//! ProseMirror.

use std::{
    collections::HashMap,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use crate::rich_editor::{
    commands::BoxCommand,
    state::{EditorState, KeyEvent, Plugin, PluginKey, PluginSpec, Transaction},
};

/// Why a binding's name could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum KeymapError {
    /// A modifier no platform has (the binding's name and the modifier).
    UnknownModifier(String, String),
}

impl fmt::Display for KeymapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownModifier(name, modifier) => {
                write!(
                    f,
                    "unrecognized modifier `{modifier}` in key binding `{name}`"
                )
            }
        }
    }
}

impl std::error::Error for KeymapError {}

/// How names are read.
#[derive(Debug, Clone)]
#[non_exhaustive]
#[derive(Default)]
pub struct KeymapOptions {
    /// Whether `Mod-` is `Meta-` (Apple platforms) rather than `Ctrl-`;
    /// by default (`None`), as each key event's platform has it (the
    /// view's [`KeyEvent::mod_key`]).
    pub mac: Option<bool>,
}

/// `name` in the normal form bindings are looked up by: modifiers in the
/// order `Shift-Meta-Ctrl-Alt-`, `Mod-` resolved, `Space` as `" "`.
pub fn normalize_key_name(name: &str, mac: bool) -> Result<String, KeymapError> {
    // A trailing `-` is the minus key, not a separator.
    let (mods, key) = match name
        .strip_suffix('-')
        .filter(|rest| rest.is_empty() || rest.ends_with('-'))
    {
        Some(rest) => (rest.strip_suffix('-').unwrap_or(rest), "-"),
        None => match name.rfind('-') {
            Some(i) => (&name[..i], &name[i + 1..]),
            None => ("", name),
        },
    };
    let mut key = if key == "Space" {
        " ".to_owned()
    } else {
        key.to_owned()
    };
    let (mut alt, mut ctrl, mut shift, mut meta) = (false, false, false, false);
    for modifier in mods.split('-').filter(|m| !m.is_empty()) {
        match modifier.to_ascii_lowercase().as_str() {
            "cmd" | "meta" | "m" => meta = true,
            "a" | "alt" => alt = true,
            "c" | "ctrl" | "control" => ctrl = true,
            "s" | "shift" => shift = true,
            "mod" => {
                if mac {
                    meta = true;
                } else {
                    ctrl = true;
                }
            }
            _ => {
                return Err(KeymapError::UnknownModifier(
                    name.to_owned(),
                    modifier.to_owned(),
                ));
            }
        }
    }
    if alt {
        key = format!("Alt-{key}");
    }
    if ctrl {
        key = format!("Ctrl-{key}");
    }
    if meta {
        key = format!("Meta-{key}");
    }
    if shift {
        key = format!("Shift-{key}");
    }
    Ok(key)
}

// The event's key with its modifiers, Shift only when `shift`.
fn modifiers(name: &str, event: &KeyEvent, shift: bool) -> String {
    let mut name = name.to_owned();
    if event.alt {
        name = format!("Alt-{name}");
    }
    if event.ctrl {
        name = format!("Ctrl-{name}");
    }
    if event.meta {
        name = format!("Meta-{name}");
    }
    if shift && event.shift {
        name = format!("Shift-{name}");
    }
    name
}

/// Bindings by normalized name, and the lookup of a key event in them.
#[derive(Clone, Default)]
pub struct Keymap {
    bindings: HashMap<String, BoxCommand>,
    /// With `Mod-` read as `Meta-`, when the platform is the event's.
    apple: Option<HashMap<String, BoxCommand>>,
}

impl fmt::Debug for Keymap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Keymap")
            .field("bindings", &self.bindings.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl Keymap {
    /// The bindings, their names normalized with `options`. A later
    /// binding of a name replaces an earlier one.
    pub fn new(
        bindings: Vec<(String, BoxCommand)>,
        options: &KeymapOptions,
    ) -> Result<Self, KeymapError> {
        let mut map = HashMap::with_capacity(bindings.len());
        let mut apple = options
            .mac
            .is_none()
            .then(|| HashMap::with_capacity(bindings.len()));
        for (name, command) in bindings {
            if let Some(apple) = &mut apple {
                apple.insert(normalize_key_name(&name, true)?, command.clone());
            }
            map.insert(
                normalize_key_name(&name, options.mac.unwrap_or(false))?,
                command,
            );
        }
        Ok(Self {
            bindings: map,
            apple,
        })
    }

    /// The command bound to a normalized name (`Mod-` read off Apple
    /// platforms when the options left it to the event).
    pub fn get(&self, name: &str) -> Option<&BoxCommand> {
        self.bindings.get(name)
    }

    // The bindings for `event`'s platform: Apple's when its command key is
    // Meta (or Control is held without being it).
    fn for_event(&self, event: &KeyEvent) -> &HashMap<String, BoxCommand> {
        match &self.apple {
            Some(apple) if (event.mod_key && event.meta) || (!event.mod_key && event.ctrl) => apple,
            _ => &self.bindings,
        }
    }

    /// Runs the command bound to `event`, as `prosemirror-keymap`'s
    /// `keydownHandler`: whether one applied.
    pub fn handle(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let name = if event.key == "Space" {
            " "
        } else {
            event.key.as_str()
        };
        let is_char = name.chars().count() == 1 && name != " ";
        let bindings = self.for_event(event);
        let mut run = |name: String| {
            bindings
                .get(&name)
                .is_some_and(|command| command(state, Some(&mut *dispatch)))
        };
        // The name with Shift spelled out first, as `prosemirror-keymap`
        // looks it up: `Mod-Shift-b` (a quote) must win over `Mod-B`
        // (bold) when Shift is held.
        if run(modifiers(name, event, true)) {
            return true;
        }
        if is_char && event.shift {
            // The base key with Shift spelled out (`Shift-Mod-z` for a Z
            // typed with Shift), then the character alone, whose Shift is
            // in its case already.
            let lower = name.to_lowercase();
            if lower != name && run(modifiers(&lower, event, true)) {
                return true;
            }
            if run(modifiers(name, event, false)) {
                return true;
            }
        }
        false
    }
}

// Makes each keymap plugin's key unique: an editor holds several.
static NEXT_KEYMAP: AtomicU64 = AtomicU64::new(0);

struct KeymapPlugin {
    key: PluginKey,
    keymap: Keymap,
}

impl PluginSpec for KeymapPlugin {
    fn key(&self) -> PluginKey {
        self.key.clone()
    }

    fn handle_key_down(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        self.keymap.handle(state, event, dispatch)
    }
}

/// A plugin running the commands bound to keys (with the platform's
/// `Mod-`). Bindings with names that cannot be read are skipped, with a
/// warning; [`keymap_with`] reports them.
pub fn keymap(bindings: Vec<(String, BoxCommand)>) -> Plugin {
    let options = KeymapOptions::default();
    let mut valid = Vec::with_capacity(bindings.len());
    for (name, command) in bindings {
        match normalize_key_name(&name, options.mac.unwrap_or(false)) {
            Ok(_) => valid.push((name, command)),
            Err(error) => log::warn!("{error}"),
        }
    }
    keymap_plugin(Keymap::new(valid, &options).unwrap_or_default())
}

/// A plugin running the commands bound to keys, reading names with
/// `options`.
pub fn keymap_with(
    bindings: Vec<(String, BoxCommand)>,
    options: &KeymapOptions,
) -> Result<Plugin, KeymapError> {
    Ok(keymap_plugin(Keymap::new(bindings, options)?))
}

/// A plugin running `keymap`'s commands.
pub fn keymap_plugin(keymap: Keymap) -> Plugin {
    let id = NEXT_KEYMAP.fetch_add(1, Ordering::Relaxed);
    Arc::new(KeymapPlugin {
        key: PluginKey::new(&format!("keymap${id}")),
        keymap,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::rich_editor::{commands::command, extensions::starter, state::EditorStateConfig};

    #[test]
    fn names_normalize() {
        assert_eq!(normalize_key_name("Mod-b", false).unwrap(), "Ctrl-b");
        assert_eq!(normalize_key_name("Mod-b", true).unwrap(), "Meta-b");
        assert_eq!(
            normalize_key_name("Shift-Enter", false).unwrap(),
            "Shift-Enter"
        );
        assert_eq!(
            normalize_key_name("Ctrl-Alt-x", false).unwrap(),
            "Ctrl-Alt-x"
        );
        assert_eq!(
            normalize_key_name("alt-shift-cmd-ctrl-k", false).unwrap(),
            "Shift-Meta-Ctrl-Alt-k"
        );
        assert_eq!(
            normalize_key_name("Shift-Mod-z", true).unwrap(),
            "Shift-Meta-z"
        );
        assert_eq!(normalize_key_name("Space", false).unwrap(), " ");
        assert_eq!(normalize_key_name("Mod--", false).unwrap(), "Ctrl--");
        assert_eq!(normalize_key_name("-", false).unwrap(), "-");
        assert!(normalize_key_name("Hyper-x", false).is_err());
    }

    #[test]
    fn events_find_their_bindings() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = |hits: &Arc<AtomicUsize>, n: usize| {
            let hits = hits.clone();
            command(move |_, _| {
                hits.fetch_add(n, Ordering::Relaxed);
                true
            })
        };
        let keymap = Keymap::new(
            vec![
                ("Mod-b".into(), counter(&hits, 1)),
                ("Shift-Mod-z".into(), counter(&hits, 10)),
                ("Shift-Enter".into(), counter(&hits, 100)),
            ],
            &KeymapOptions { mac: Some(false) },
        )
        .unwrap();
        let state = EditorState::create(EditorStateConfig::new(starter::schema())).unwrap();
        let mut dispatch = |_| {};
        let event = |key: &str, ctrl: bool, shift: bool| KeyEvent {
            ctrl,
            shift,
            ..KeyEvent::new(key)
        };
        assert!(keymap.handle(&state, &event("b", true, false), &mut dispatch));
        assert!(keymap.handle(&state, &event("Z", true, true), &mut dispatch));
        assert!(keymap.handle(&state, &event("Enter", false, true), &mut dispatch));
        assert!(!keymap.handle(&state, &event("Enter", false, false), &mut dispatch));
        assert!(!keymap.handle(&state, &event("b", false, false), &mut dispatch));
        assert_eq!(hits.load(Ordering::Relaxed), 111);
    }

    #[test]
    fn shift_spelled_bindings_win() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = |hits: &Arc<AtomicUsize>, n: usize| {
            let hits = hits.clone();
            command(move |_, _| {
                hits.fetch_add(n, Ordering::Relaxed);
                true
            })
        };
        // Bold binds `Mod-b` and `Mod-B`, the quote `Mod-Shift-b`, as
        // Tiptap's extensions do.
        let keymap = Keymap::new(
            vec![
                ("Mod-b".into(), counter(&hits, 1)),
                ("Mod-B".into(), counter(&hits, 1)),
                ("Mod-Shift-b".into(), counter(&hits, 100)),
            ],
            &KeymapOptions { mac: Some(false) },
        )
        .unwrap();
        let state = EditorState::create(EditorStateConfig::new(starter::schema())).unwrap();
        let mut dispatch = |_| {};
        let event = |key: &str, shift: bool| KeyEvent {
            ctrl: true,
            shift,
            ..KeyEvent::new(key)
        };
        // Ctrl-Shift-B, as platforms report it (uppercase or not): the quote.
        assert!(keymap.handle(&state, &event("B", true), &mut dispatch));
        assert_eq!(hits.swap(0, Ordering::Relaxed), 100);
        assert!(keymap.handle(&state, &event("b", true), &mut dispatch));
        assert_eq!(hits.swap(0, Ordering::Relaxed), 100);
        // Ctrl-B: bold.
        assert!(keymap.handle(&state, &event("b", false), &mut dispatch));
        assert_eq!(hits.swap(0, Ordering::Relaxed), 1);
        // A Shift binding of its own missing, a shifted letter still finds
        // the character's binding (`Mod-B`).
        let bold_only = Keymap::new(
            vec![("Mod-B".into(), counter(&hits, 1))],
            &KeymapOptions { mac: Some(false) },
        )
        .unwrap();
        assert!(bold_only.handle(&state, &event("B", true), &mut dispatch));
        assert_eq!(hits.swap(0, Ordering::Relaxed), 1);
    }
}
