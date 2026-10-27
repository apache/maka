//! `RichEditor`'s headless kernel, after ProseMirror's architecture: a
//! document whose structure the app's [`Schema`] defines (`model`), changes
//! as invertible, mappable steps (`transform`), immutable editor states
//! that transactions advance (`state`), editing commands (`commands`),
//! optional behavior (`extensions`: history, keymaps, input rules) and the
//! adapters to the app's formats (`formats`). None of it depends on a view:
//! it runs and is tested on its own; the native view renders its states.
//!
//! Positions count as ProseMirror's do: a text counts its UTF-16 code
//! units, a leaf node one, a node with content its two boundaries.
//! See docs/dev/rich-editor.md.
//!
//! # Credits
//!
//! The kernel is a Rust port of [ProseMirror](https://prosemirror.net)
//! (`prosemirror-model`, `-transform`, `-state`, `-commands`,
//! `-schema-list`, `-history`, `-keymap`, `-inputrules`, `-gapcursor`,
//! `-dropcursor` and `-tables`; MIT, © Marijn Haverbeke and others): its
//! data structures, algorithms and names follow ProseMirror's. The
//! extension layer (`extensions`: extensions, the starter kit, their
//! commands, keymaps and rules) follows [Tiptap](https://tiptap.dev)
//! (MIT, © Tiptap GmbH), whose names, options and command semantics it
//! keeps. Both projects' MIT licenses apply to the parts ported from them.

pub mod commands;
pub mod extensions;
pub mod formats;
pub(crate) mod js;
pub mod model;
pub mod state;
pub mod transform;
pub mod view;
