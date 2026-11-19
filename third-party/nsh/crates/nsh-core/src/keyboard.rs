//! Hardware key transitions and mounted capture rules for custom Rust views
//! and for TSX views.
//!
//! Desktops and browsers deliver [`KeyEvent`] notifications for the
//! focused view; app-rendered interaction surfaces can forward the logical
//! key, its DOM `code`, repeats and releases to their own input engine. Raw
//! key names are input data: the DOM's spelling for named keys, and the
//! character a printable key reports, never forced onto a made-up layout.
//! `code` is the source's physical identity in the DOM's spelling, mapped
//! by the backend from the native identifier it really has; a source
//! without one reports `""` and is never guessed from the logical key.
//! Named shortcuts remain [`crate::keymap`]'s responsibility.
//!
//! [`KeyCapture`] decides native consumption before callbacks run. Its keys
//! are canonical [`Keystroke`]s, so a capture shares the shortcut vocabulary
//! and normalization. The platform matches them against the transition's
//! canonical shortcut stroke, which its own shortcut matcher builds, never
//! against the event's `key` or `code`. Focus stays with the platform's
//! existing Tab and explicit-focus behavior.

use std::sync::Arc;

use crate::{
    element::SharedString,
    keymap::{Keystroke, Modifiers},
};

/// A key that went down or came up on the focused view (`on_key_down` /
/// `on_key_up`), as GPUI's `KeyDownEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct KeyEvent {
    /// The logical key the source reports: the DOM's spelling for named
    /// keys (`"Enter"`, `"Escape"`, `"ArrowLeft"`) and the character a
    /// printable key reports in its actual case, on the layout in use. Not
    /// normalized to another layout. `"Unidentified"` when the source names
    /// none.
    pub key: SharedString,
    /// The key's physical identity as the DOM's `KeyboardEvent.code` spells
    /// it (`"KeyA"`, `"ArrowLeft"`, `"NumpadEnter"`, `"ShiftLeft"`), mapped
    /// by the backend from the native identifier it really has: a Windows
    /// scan code, AppKit's `NSEvent.keyCode`, or a GTK hardware keycode;
    /// browsers provide their DOM code directly. `""` when the source has no
    /// physical identity (GPUI's logical events, synthetic input): the
    /// empty string is the DOM's unknown code, and no backend infers a code
    /// from the printable or logical key.
    pub code: SharedString,
    /// The modifiers held after this transition. Releasing one Shift keeps
    /// `shift` set while the other Shift is still held.
    pub modifiers: Modifiers,
    /// An auto-repeat of a key held down (the press itself is not one).
    pub repeat: bool,
    /// Whether the mounted [`KeyCapture`] rule of the focused view or an
    /// enabled ancestor decided this transition before it ran: the platform
    /// runs no native default and types no text. It is the decision for
    /// this one transition, observable state as the DOM's `defaultPrevented`
    /// is, not a veto a listener can cast: the UI thread does not wait for
    /// engine-thread JS or Rust callbacks, which are told after the fact.
    pub default_prevented: bool,
}

impl Default for KeyEvent {
    /// A key the source has not identified.
    fn default() -> Self {
        Self {
            key: SharedString::new_static("Unidentified"),
            code: SharedString::default(),
            modifiers: Modifiers::default(),
            repeat: false,
            default_prevented: false,
        }
    }
}

/// The keys a view consumes before the platform's native defaults run
/// ([`crate::element::Interactive::capture_keys`]).
///
/// A view mounts one as a reactive prop; the platform reads the mounted
/// rule of the focused view and its ancestry and decides without waiting
/// for a listener. An eligible app shortcut keeps its priority, and a
/// native input or child keeps its own keys. Disabled views, and views that
/// left the focused view's ancestry, capture nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum KeyCapture {
    /// Nothing is captured (the default).
    #[default]
    None,
    /// Every key is captured, named and modifier keys included.
    All,
    /// The listed keys are captured: each canonical [`Keystroke`] matches
    /// the same key and exactly its modifiers.
    Keys(Arc<[Keystroke]>),
}

impl KeyCapture {
    /// A rule capturing `keys` (each a [`Keystroke`]'s key and modifiers,
    /// both exact).
    pub fn keys(keys: impl IntoIterator<Item = Keystroke>) -> Self {
        KeyCapture::Keys(keys.into_iter().collect())
    }

    /// Whether this rule captures nothing: [`Self::None`], or
    /// [`Self::Keys`] without keys. The platform need not look at a key's
    /// event where it is true.
    #[doc(hidden)]
    pub fn is_none(&self) -> bool {
        match self {
            KeyCapture::None => true,
            KeyCapture::All => false,
            KeyCapture::Keys(keys) => keys.is_empty(),
        }
    }

    /// Matches the backend's canonical shortcut stroke. A key with no
    /// representable stroke matches only [`Self::All`].
    #[doc(hidden)]
    pub fn captures_key(&self, keystroke: Option<&Keystroke>) -> bool {
        match self {
            KeyCapture::None => false,
            KeyCapture::All => true,
            KeyCapture::Keys(keys) => keystroke.is_some_and(|keystroke| keys.contains(keystroke)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keystroke `text` names on a non-Apple platform.
    fn stroke(text: &str) -> Keystroke {
        Keystroke::parse_with(text, false).expect(text)
    }

    #[test]
    fn a_default_event_names_no_key_and_captures_nothing() {
        let event = KeyEvent::default();
        assert_eq!(event.key.as_str(), "Unidentified");
        assert_eq!(event.code.as_str(), "");
        assert_eq!(event.modifiers, Modifiers::default());
        assert!(!event.repeat && !event.default_prevented);
    }

    #[test]
    fn a_capture_with_no_keys_is_none() {
        assert!(KeyCapture::None.is_none());
        assert!(KeyCapture::keys(std::iter::empty()).is_none());
        assert!(!KeyCapture::All.is_none());
        assert!(!KeyCapture::keys([stroke("a")]).is_none());
    }

    #[test]
    fn capture_matches_the_stroke_and_modifiers_exactly() {
        let a = stroke("a");
        assert!(!KeyCapture::default().captures_key(Some(&a)));
        assert!(!KeyCapture::None.captures_key(Some(&a)));
        assert!(KeyCapture::All.captures_key(Some(&a)));
        assert!(KeyCapture::keys([stroke("a")]).captures_key(Some(&a)));
        // A keystroke names the modifiers it needs, all of them.
        assert!(!KeyCapture::keys([stroke("shift+a")]).captures_key(Some(&a)));
        assert!(!KeyCapture::keys([stroke("ctrl+a")]).captures_key(Some(&a)));
        assert!(!KeyCapture::keys([stroke("b")]).captures_key(Some(&a)));

        // Names the shortcut vocabulary has, with exact modifiers.
        for (name, expected) in [
            ("left", stroke("left")),
            ("enter", stroke("enter")),
            ("escape", stroke("escape")),
            ("tab", stroke("tab")),
            ("backspace", stroke("backspace")),
            ("delete", stroke("delete")),
            ("pagedown", stroke("pagedown")),
            ("f5", stroke("f5")),
            ("space", stroke("space")),
        ] {
            assert!(
                KeyCapture::keys([expected]).captures_key(Some(&expected)),
                "{name}"
            );
        }
        // Shift+A is the `a` key with Shift: what the platform's matcher
        // builds, not the reported character.
        let shifted = Keystroke {
            modifiers: Modifiers {
                shift: true,
                ..Default::default()
            },
            key: crate::keymap::Key::Char('a'),
        };
        assert!(KeyCapture::keys([stroke("shift+a")]).captures_key(Some(&shifted)));
        assert!(!KeyCapture::keys([stroke("a")]).captures_key(Some(&shifted)));

        // A shortcut names US-layout ASCII keys: another layout's character
        // has no keystroke, and only `All` captures it.
        assert!(KeyCapture::All.captures_key(None));
        assert!(!KeyCapture::keys([stroke("a")]).captures_key(None));
        assert!(!KeyCapture::None.captures_key(None));
    }
}
