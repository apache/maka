//! The languages and highlighters an engine knows besides the built-in
//! ones: the app registers them (a Rust app before it mounts its editors,
//! an app's crate in its UI set's setup, `Registry::setup`), each engine
//! keeps its own (a value of its surface, `nsh_core::element::global`), and
//! `language="…"` finds them before the built-in table.

use std::rc::Rc;

use nsh_core::prelude::{global, try_global};

use super::{
    highlight::{Factory, Syntax},
    highlighter::EditorHighlighter,
    language::{self, LanguageConfig, PLAIN_TEXT},
};

/// A language an app teaches its editors ([`register_language`]): its
/// names, the files it is for, and the rules editing it follows
/// (comments, brackets, the pairs typing closes, word characters,
/// indentation), as the built-in languages have them. Static data, built
/// in a `static` with its `const` methods:
///
/// ```ignore
/// static NIMBLE: EditorLanguage = EditorLanguage::new("Nimble")
///     .aliases(&["nimble"])
///     .extensions(&["nb", "nimble"])
///     .line_comment("#")
///     .tab_size(2);
/// ```
///
/// It starts as a language of brackets `()`, `[]` and `{}`, with quotes
/// paired, no comments and an indent of 4 spaces; without
/// [`EditorLanguage::syntax`] or a highlighter of its own
/// ([`register_highlighter`]) its text is plain.
#[derive(Debug)]
#[non_exhaustive]
pub struct EditorLanguage {
    config: LanguageConfig,
}

impl Default for EditorLanguage {
    fn default() -> Self {
        EditorLanguage::new("")
    }
}

impl EditorLanguage {
    /// A language named `name` ("Nimble"): the name `language` takes
    /// (case-insensitive) and the one shown.
    pub const fn new(name: &'static str) -> EditorLanguage {
        EditorLanguage {
            config: LanguageConfig {
                name,
                syntax_hint: "",
                aliases: &[],
                extensions: &[],
                file_names: &[],
                line_comment: None,
                block_comment: None,
                brackets: &[('(', ')'), ('[', ']'), ('{', '}')],
                auto_close: &[('(', ')'), ('[', ']'), ('{', '}'), ('"', '"'), ('\'', '\'')],
                word_chars: "",
                hard_tabs: false,
                tab_size: 4,
                string_quotes: "\"'",
                indent_rule: None,
                outdent_rule: None,
            },
        }
    }

    /// Its name.
    pub const fn name(&self) -> &'static str {
        self.config.name
    }

    /// Other names `language` takes: a language server's language id, a
    /// Markdown fence's name.
    pub const fn aliases(mut self, aliases: &'static [&'static str]) -> Self {
        self.config.aliases = aliases;
        self
    }

    /// The extensions of its files, without the dot (`language` takes a
    /// file's name or path and finds it by them).
    pub const fn extensions(mut self, extensions: &'static [&'static str]) -> Self {
        self.config.extensions = extensions;
        self
    }

    /// Whole names of its files ("Justfile").
    pub const fn file_names(mut self, file_names: &'static [&'static str]) -> Self {
        self.config.file_names = file_names;
        self
    }

    /// What starts a line comment ("//", "#", "--"): what toggling a
    /// comment adds, and what indentation reads past.
    pub const fn line_comment(mut self, marker: &'static str) -> Self {
        self.config.line_comment = Some(marker);
        self
    }

    /// What opens and closes a block comment ("/*" and "*/").
    pub const fn block_comment(mut self, open: &'static str, close: &'static str) -> Self {
        self.config.block_comment = Some((open, close));
        self
    }

    /// The pairs bracket matching and indentation use.
    pub const fn brackets(mut self, brackets: &'static [(char, char)]) -> Self {
        self.config.brackets = brackets;
        self
    }

    /// The pairs typing an opening character closes: brackets and quotes.
    pub const fn auto_close(mut self, pairs: &'static [(char, char)]) -> Self {
        self.config.auto_close = pairs;
        self
    }

    /// Word characters besides letters, digits and `_` (`$`, `-`): what
    /// word movement, double-click and completion take as one word.
    pub const fn word_chars(mut self, chars: &'static str) -> Self {
        self.config.word_chars = chars;
        self
    }

    /// Its files are indented with tabs.
    pub const fn hard_tabs(mut self, hard_tabs: bool) -> Self {
        self.config.hard_tabs = hard_tabs;
        self
    }

    /// Its usual indent width, in columns.
    pub const fn tab_size(mut self, tab_size: u32) -> Self {
        self.config.tab_size = tab_size;
        self
    }

    /// The quotes that open strings on one line, so a comment marker in a
    /// string is not taken for a comment.
    pub const fn string_quotes(mut self, quotes: &'static str) -> Self {
        self.config.string_quotes = quotes;
        self
    }

    /// The built-in highlighter's syntax its text is highlighted with: an
    /// extension or a name it knows ("toml", "rs"), for a language that
    /// reads as one of the built-in ones. A highlighter of its own
    /// ([`register_highlighter`]) takes its place.
    pub const fn syntax(mut self, hint: &'static str) -> Self {
        self.config.syntax_hint = hint;
        self
    }

    /// What indents the line after a line, besides an opening bracket at
    /// its end: `rule(line, code)` with the whole line and its code (the
    /// line without its trailing comment, trimmed), for a language's
    /// keywords (`do`, `then`, a `:` at the end).
    pub const fn indent_after(mut self, rule: fn(line: &str, code: &str) -> bool) -> Self {
        self.config.indent_rule = Some(rule);
        self
    }

    /// What outdents a line as it is typed, besides a closing bracket at
    /// its start: `rule(line, text)` with the whole line and its text
    /// without indentation, trimmed (`end`, `else`).
    pub const fn outdent(mut self, rule: fn(line: &str, text: &str) -> bool) -> Self {
        self.config.outdent_rule = Some(rule);
        self
    }
}

/// Teaches this engine's editors and diff views `language`: a
/// `language` prop naming it (its name, an alias, an extension, a file's
/// name or path) finds it before the built-in languages, which a
/// registration of the same name or extension so replaces. Editors
/// showing a language look it up again when one is registered. Call it
/// in the engine (a Rust app's root component before it mounts its
/// editors; an app's crate from its UI set's setup, `Registry::setup`);
/// a language built at run time is leaked once (`Box::leak`) to be
/// `'static`.
///
/// # Panics
///
/// Outside an engine (where no reactive runtime runs).
pub fn register_language(language: &'static EditorLanguage) {
    let config = &language.config;
    global::<Languages>().update(|l| {
        l.languages.retain(|c| !std::ptr::eq(*c, config));
        l.languages.push(config);
    });
}

/// Highlights the language `language` names (as the `language` prop
/// names one: a built-in language or one [`register_language`]
/// registered first) with the app's highlighter in this engine's
/// editors and diff views, in place of the built-in highlighting: `make`
/// makes one for each text (and for each guess of the lines in view, when
/// the highlighter guesses). The latest registration for a language is
/// the one used. See [`register_language`] for where to call it.
///
/// # Panics
///
/// Outside an engine (where no reactive runtime runs).
pub fn register_highlighter(
    language: &str,
    make: impl Fn() -> Box<dyn EditorHighlighter> + 'static,
) {
    let languages = global::<Languages>();
    let name = languages.with_untracked(|l| match l.find(language) {
        Some(config) => config.name.to_owned(),
        None => language.trim().to_owned(),
    });
    let make: Factory = Rc::new(make);
    languages.update(|l| {
        l.highlighters
            .retain(|(n, _)| !n.eq_ignore_ascii_case(&name));
        l.highlighters.push((name, make));
    });
}

/// The language `name` names and what highlights it: this engine's
/// registered languages and highlighters first, then the built-in ones.
/// Reading them subscribes: a registration since finds them again. Off
/// an engine (a unit test), the built-in ones.
pub(crate) fn resolve(name: &str) -> (&'static LanguageConfig, Syntax) {
    let Some(languages) = try_global::<Languages>() else {
        let language = language::language(name);
        return (language, Syntax::builtin(language.syntax_hint));
    };
    languages.with(|l| {
        let language = l.find(name).unwrap_or(&PLAIN_TEXT);
        let syntax = l
            .highlighters
            .iter()
            .rev()
            .find(|(n, _)| n.eq_ignore_ascii_case(language.name))
            .map(|(_, make)| Syntax::App(make.clone()))
            .unwrap_or_else(|| Syntax::builtin(language.syntax_hint));
        (language, syntax)
    })
}

/// What an engine registered.
#[derive(Clone, Default)]
struct Languages {
    /// In order: the latest of a name wins.
    languages: Vec<&'static LanguageConfig>,
    /// By language name.
    highlighters: Vec<(String, Factory)>,
}

impl Languages {
    /// The language `name` names, registered or built in; None for plain
    /// text.
    fn find(&self, name: &str) -> Option<&'static LanguageConfig> {
        let found = self
            .registered(name)
            .unwrap_or_else(|| language::language(name));
        (!std::ptr::eq(found, &PLAIN_TEXT)).then_some(found)
    }

    /// A registered language `name` names, as the built-in ones are found:
    /// by name, alias or extension, else as a path, by its file name, then
    /// its extensions from the longest.
    fn registered(&self, name: &str) -> Option<&'static LanguageConfig> {
        let name = name.trim();
        if name.is_empty() || self.languages.is_empty() {
            return None;
        }
        let is = |s: &&str| s.eq_ignore_ascii_case(name);
        let latest = || self.languages.iter().rev().copied();
        if let Some(found) = latest().find(|l| {
            l.name.eq_ignore_ascii_case(name)
                || l.aliases.iter().any(is)
                || l.extensions.iter().any(is)
        }) {
            return Some(found);
        }
        let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
        if base.is_empty() {
            return None;
        }
        if let Some(found) =
            latest().find(|l| l.file_names.iter().any(|f| f.eq_ignore_ascii_case(base)))
        {
            return Some(found);
        }
        base.match_indices('.').find_map(|(at, _)| {
            let ext = &base[at + 1..];
            latest().find(|l| l.extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)))
        })
    }
}
