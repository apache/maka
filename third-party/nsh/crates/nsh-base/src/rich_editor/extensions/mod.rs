//! Optional editor behavior on the kernel's plugins: undo history
//! ([`history`], after `prosemirror-history`), key bindings ([`keymap`],
//! after `prosemirror-keymap`), input rules ([`input_rules`], after
//! `prosemirror-inputrules`), Tiptap's extensions ([`extension`]: one
//! unit of schema types, bindings, rules, plugins and commands, resolved
//! by an [`ExtensionManager`]) with the built-in ones ([`kit`], the
//! starter kit among them), and a starter set ([`starter`]): the starter
//! kit's schema, bindings, rules and plugins as plain functions. None of
//! it is built in: an editor takes the pieces it wants, or its own.

pub mod character_count;
pub mod clear_document;
pub mod code_block;
pub mod core_keymap;
pub mod extension;
pub(crate) mod helpers;
pub mod history;
pub mod input_rules;
pub mod keymap;
pub mod kit;
pub mod link;
pub mod list_keymap;
pub mod markdown;
pub mod paste_rules;
pub mod starter;
pub mod suggestion;
pub mod trailing_node;
pub mod typography;

pub use extension::{
    DEFAULT_PRIORITY, Extension, ExtensionContext, ExtensionError, ExtensionKind, ExtensionManager,
    GlobalAttributes, RichExtensionRegistry, core_extensions, extension_named, merge_options,
    register_extension,
};
pub use history::{
    HistoryOptions, HistoryState, close_history, history, history_key, history_state,
    is_history_transaction, redo, redo_depth, redo_no_scroll, undo, undo_depth, undo_no_scroll,
};
pub use input_rules::{
    GetAttrs, InCode, InputFinder, InputMatch, InputRule, InputRuleHandler, InputRulesState,
    JoinPredicate, ellipsis, em_dash, input_rules, mark_input_rule, node_input_rule, smart_quotes,
    textblock_type_input_rule, undo_input_rule, wrapping_input_rule,
};
pub use keymap::{
    Keymap, KeymapError, KeymapOptions, keymap, keymap_plugin, keymap_with, normalize_key_name,
};

#[cfg(test)]
mod list_scenarios;
