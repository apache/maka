//! What `TextView`'s code blocks and the `Editor` share of syntax
//! highlighting: the kinds of token and their colors, Allsum's reading
//! palette, and (feature `highlight`) syntect's syntaxes, the lookup of a
//! language's syntax and the mapping of TextMate scopes to tokens.
//!
//! Syntect names what it matched with TextMate scopes
//! (`keyword.control.rust`, `string.quoted.double`). Those map to a few
//! kinds of token, each with a light and a dark color, so one parse gives
//! the styles of both appearances and the colors follow the appearance
//! without highlighting again. What maps to nothing keeps the code's own
//! color (the app's).

use nsh_core::{element::StyleRefinement, prelude::*};

#[cfg(feature = "highlight")]
pub(crate) use self::syntect_syntaxes::{find_syntax, loaded, plain, scope_token, syntaxes};

/// What a span of code is, colored alike (as Allsum's `--hl-*` tokens
/// color highlight.js's classes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// Without the feature nothing parses code, so nothing makes tokens.
#[cfg_attr(not(feature = "highlight"), allow(dead_code))]
pub(crate) enum Token {
    Comment,
    /// Keywords, the words of operators (`as`, `typeof`), headings.
    Keyword,
    /// Strings, regular expressions, escapes, a diff's added lines.
    String,
    /// Numbers, constants and literals (`true`, `null`).
    Number,
    /// Names of functions and classes.
    Title,
    /// Attributes, parameters, properties, keys, shell variables,
    /// `self` / `this`.
    Attr,
    /// Built-ins: types, functions; tags.
    Built,
    /// A diff's removed lines.
    Deletion,
    Bold,
    Italic,
    /// An operator: a keyword when it is a word (Rust's `as`), else
    /// plain. Settled by its text ([`Token::settle`]).
    Operator,
    /// A grammar's plain `storage.type`, which some give declarations
    /// and types alike (Rust's `let` and `f32`). Settled by its text.
    Storage,
}

#[cfg_attr(not(feature = "highlight"), allow(dead_code))]
impl Token {
    /// Allsum's reading palette (its `--hl-*` tokens), light and dark.
    pub(crate) fn style(self) -> StyleRefinement {
        let s = StyleRefinement::default();
        let color = AdaptiveColor::rgb;
        match self {
            Self::Comment => s.text_color(color(0x6e7781, 0x7d7a72)).italic(),
            Self::Keyword => s.text_color(color(0x8250df, 0xc4a7ff)),
            Self::String => s.text_color(color(0x116329, 0x9fd68a)),
            Self::Number => s.text_color(color(0x953800, 0xf5b27a)),
            Self::Title => s.text_color(color(0x0550ae, 0x82b8ff)),
            Self::Attr => s.text_color(color(0x7d4e00, 0xf0c674)),
            Self::Built => s.text_color(color(0x0a7285, 0x6fd3d8)),
            Self::Deletion => s.text_color(color(0xcf222e, 0xf87171)),
            Self::Bold => s.font_weight(FontWeight::BOLD),
            Self::Italic => s.italic(),
            Self::Operator | Self::Storage => s,
        }
    }

    /// The token of `text` for the tokens its scope leaves open.
    fn settle(self, text: &str) -> Option<Self> {
        const DECLARING: &[&str] = &[
            "let",
            "const",
            "var",
            "static",
            "mut",
            "fn",
            "func",
            "function",
            "def",
            "class",
            "struct",
            "enum",
            "union",
            "trait",
            "impl",
            "type",
            "interface",
            "module",
            "mod",
            "namespace",
            "typedef",
            "val",
            "extern",
            "async",
        ];
        match self {
            Self::Operator => text
                .chars()
                .all(|c| c.is_ascii_alphabetic())
                .then_some(Self::Keyword),
            Self::Storage if DECLARING.contains(&text) => Some(Self::Keyword),
            Self::Storage => Some(Self::Built),
            token => Some(token),
        }
    }
}

#[cfg(feature = "highlight")]
mod syntect_syntaxes {
    use std::{cell::RefCell, collections::HashMap, sync::OnceLock};

    use syntect::parsing::{Scope, ScopeStack, SyntaxReference, SyntaxSet};

    use super::Token;

    /// Deserializing the syntaxes takes tens of milliseconds: once per
    /// process, on a blocking thread where the caller can.
    static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();

    thread_local! {
        /// The token of each scope met (building a scope's name is slow).
        static TOKENS: RefCell<HashMap<Scope, Option<Token>>> = RefCell::default();
    }

    /// bat's syntaxes (two-face's), loaded on the first call: syntaxes
    /// that expect each line with its line break.
    pub(crate) fn syntaxes() -> &'static SyntaxSet {
        SYNTAXES.get_or_init(two_face::syntax::extra_newlines)
    }

    /// Whether the syntaxes are loaded ([`syntaxes`] returns at once).
    pub(crate) fn loaded() -> bool {
        SYNTAXES.get().is_some()
    }

    /// Languages that are plain text.
    pub(crate) fn plain(language: &str) -> bool {
        ["", "text", "txt", "plain", "plaintext"]
            .iter()
            .any(|plain| language.eq_ignore_ascii_case(plain))
    }

    /// The syntax of a language: an extension or a name (case-insensitive),
    /// or one of the other names code fences use. Loads the syntaxes.
    pub(crate) fn find_syntax(language: &str) -> Option<&'static SyntaxReference> {
        let language = language.trim();
        if plain(language) {
            return None;
        }
        let alias = match language.to_ascii_lowercase().as_str() {
            "shell" | "console" | "shellscript" => "sh",
            "golang" => "go",
            // TSX reads JSX too (no JSX grammar of its own here).
            "jsx" => "tsx",
            "mjs" | "cjs" => "js",
            "c++" => "cpp",
            "c#" | "csharp" => "cs",
            "f#" | "fsharp" => "fs",
            "jsonc" | "json5" => "json",
            "objective-c" | "objc" => "m",
            "docker" => "Dockerfile",
            "make" => "Makefile",
            "vue" | "svelte" => "html",
            _ => language,
        };
        syntaxes()
            .find_syntax_by_token(alias)
            .filter(|syntax| syntax.name != "Plain Text")
    }

    /// The token of `text` (what syntect matched) under `scopes`: that of
    /// its innermost scope that has one, settled by the text.
    pub(crate) fn scope_token(scopes: &ScopeStack, text: &str) -> Option<Token> {
        let token = TOKENS.with_borrow_mut(|names| {
            scopes
                .as_slice()
                .iter()
                .rev()
                .find_map(|scope| *names.entry(*scope).or_insert_with(|| token(*scope)))
        });
        token.and_then(|token| token.settle(text.trim()))
    }

    /// The token of a TextMate scope, or `None` to let an enclosing scope
    /// decide. The website's Shiki themes (`website/src/*.theme.json`)
    /// color the same scopes alike.
    fn token(scope: Scope) -> Option<Token> {
        let scope = scope.build_string();
        let is = |prefix: &str| {
            scope
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
        };
        let token = if is("meta.object-literal.key") || is("meta.mapping.key") {
            Token::Attr
        } else if is("punctuation") || is("invalid") || is("meta") || is("source") || is("text") {
            // Delimiters belong to what they delimit; the rest are
            // containers with no color of their own.
            return None;
        } else if is("comment") {
            Token::Comment
        } else if is("string") || is("constant.character.escape") {
            Token::String
        } else if is("constant")
            || is("support.constant")
            || is("variable.other.constant")
            || is("entity.name.constant")
        {
            Token::Number
        } else if is("support.type.property-name")
            || is("entity.other.attribute-name")
            || is("variable.parameter")
            || is("variable.language")
            || is("variable.other.property")
            || is("variable.other.object.property")
            || is("variable.other.member")
            || is("entity.name.tag.yaml")
            || is("entity.name.tag.toml")
            || (is("variable.other") && scope.ends_with(".shell"))
        {
            Token::Attr
        } else if is("support.function.builtin")
            || is("support.macro")
            || is("support.type")
            || is("entity.name.tag")
        {
            Token::Built
        } else if is("keyword.operator") {
            // Words are keywords (`as`, `typeof`, `in`), symbols are plain.
            Token::Operator
        } else if is("storage.type") {
            // `storage.type.function.rust` declares, `storage.type.numeric.go`
            // is a type, `storage.type.rust` is either.
            match scope.split('.').count() {
                ..=3 => Token::Storage,
                _ if [
                    "class",
                    "enum",
                    "function",
                    "impl",
                    "interface",
                    "module",
                    "namespace",
                    "struct",
                    "trait",
                    "type.type",
                    "union",
                    "def",
                    "fn",
                ]
                .iter()
                .any(|kind| scope[13..].starts_with(kind)) =>
                {
                    Token::Keyword
                }
                _ => Token::Built,
            }
        } else if is("keyword")
            || is("storage")
            || is("entity.name.section")
            || is("markup.heading")
        {
            Token::Keyword
        } else if is("entity.name")
            || is("entity.other.inherited-class")
            || is("support.function")
            || is("support.class")
            || is("variable.function")
        {
            Token::Title
        } else if is("markup.inserted") {
            Token::String
        } else if is("markup.deleted") {
            Token::Deletion
        } else if is("markup.bold") {
            Token::Bold
        } else if is("markup.italic") {
            Token::Italic
        } else {
            return None;
        };
        Some(token)
    }
}
