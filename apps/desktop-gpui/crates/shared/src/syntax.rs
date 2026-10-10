/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! The code languages gpui-kit's highlighter knows, as the app adds to
//! them: the grammars are the curated set the workspace builds the kit
//! with (`Cargo.toml`), under the kit's names and aliases (`rust` and `rs`,
//! `typescript` and `ts`, `bash` and `sh` …), and [`register_languages`]
//! adds what a reply's code fence often says instead, and colours a diff's
//! removed lines as removed.
//!
//! Where code is coloured: a Markdown code block with a language (the
//! transcript, a Markdown file in Files, the daily review), a diff by each
//! file's extension (the changes panel, a tool card, a diff in Files), and
//! the Files source view by the file's extension or media type. An
//! untagged code block stays in the ink.

use std::ops::Range;
use std::sync::Once;

use gpui_kit::HighlightStyle;
use gpui_kit::component::Rope;
use gpui_kit::component::highlighter::{HighlightTheme, LanguageRegistry, SyntaxHighlighter};

/// The languages the workspace builds gpui-kit with, by the kit's names.
pub const LANGUAGES: [&str; 18] = [
    "bash",
    "c",
    "cpp",
    "css",
    "diff",
    "go",
    "html",
    "java",
    "javascript",
    "json",
    "markdown",
    "python",
    "rust",
    "sql",
    "toml",
    "tsx",
    "typescript",
    "yaml",
];

/// Code fence names the kit does not know, and the language each means.
const ALIASES: [(&str, &str); 4] =
    [("shell", "bash"), ("zsh", "bash"), ("jsx", "javascript"), ("patch", "diff")];

/// tree-sitter-diff's own highlights (`queries/highlights.scm`, MIT) with
/// a removed line captured as `tag` instead of `keyword`. The kit's theme
/// has no name for an added or a removed line; the grammar already gives
/// an added line `string`, which Maka colours green, and Maka colours
/// `tag` red ([`crate::theme::SYNTAX_NAMES`]), where `keyword` is violet.
const DIFF_HIGHLIGHTS: &str = "\
[(addition) (new_file)] @string
[(deletion) (old_file)] @tag

(commit) @constant
(location) @attribute
(command) @variable.builtin
";

/// Registers the diff grammar with [`DIFF_HIGHLIGHTS`] and the fence
/// [`ALIASES`] with gpui-kit's language registry, once per process: a
/// registration drops the kit's cached code block highlighters, so it is
/// not repeated. [`crate::theme::apply_kit_theme`] calls it.
pub fn register_languages() {
    static REGISTERED: Once = Once::new();
    REGISTERED.call_once(|| {
        let registry = LanguageRegistry::singleton();
        if let Some(mut diff) = registry.language("diff") {
            diff.highlights = DIFF_HIGHLIGHTS.into();
            registry.register("diff", &diff);
        }
        for (alias, language) in ALIASES {
            if let Some(config) = registry.language(language) {
                registry.register(alias, &config);
            }
        }
    });
}

/// What gpui-kit's highlighter gives `code` in `language` under `theme`:
/// the styled ranges a code block, a diff line or the editor paints. Only
/// tests read it whole; the surfaces themselves ask the kit.
pub fn highlight(
    language: &str,
    code: &str,
    theme: &HighlightTheme,
) -> Vec<(Range<usize>, HighlightStyle)> {
    let mut highlighter = SyntaxHighlighter::new(language);
    highlighter.update(None, &Rope::from_str(code), None);
    highlighter.styles(&(0..code.len()), theme)
}

#[cfg(test)]
mod tests {
    use gpui_kit::component::ThemeMode;

    use super::*;
    use crate::palette::ThemePalette;
    use crate::theme::{SyntaxPalette, highlight_theme};

    /// The colour `styles` give the first `needle` in `code`.
    fn color_of(
        styles: &[(Range<usize>, HighlightStyle)],
        code: &str,
        needle: &str,
    ) -> Option<gpui_kit::Hsla> {
        let start = code.find(needle).unwrap_or_else(|| panic!("{needle} in {code}"));
        let range = start..start + needle.len();
        styles
            .iter()
            .find(|(span, _)| span.start <= range.start && span.end >= range.end)
            .and_then(|(_, style)| style.color)
    }

    #[test]
    fn every_curated_language_has_its_grammar_and_others_have_none() {
        register_languages();
        let registry = LanguageRegistry::singleton();
        for language in LANGUAGES {
            let config = registry.language(language);
            assert!(config.is_some_and(|config| config.has_grammar()), "{language}");
        }
        for (alias, language) in ALIASES {
            assert_eq!(registry.language(alias).map(|config| config.name), Some(language.into()));
        }
        for left_out in ["zig", "ruby", "kotlin", "swift"] {
            assert!(
                registry.language(left_out).is_none_or(|config| !config.has_grammar()),
                "{left_out} is not built"
            );
        }
    }

    #[test]
    fn a_diff_block_colours_added_lines_green_and_removed_lines_red() {
        register_languages();
        let syntax = SyntaxPalette::for_palette(ThemePalette::Default, ThemeMode::Light);
        let theme = highlight_theme(ThemePalette::Default, ThemeMode::Light);
        let code = "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-old line\n+new line\n";
        for language in ["diff", "patch"] {
            let styles = highlight(language, code, &theme);
            assert_eq!(color_of(&styles, code, "+new line"), Some(syntax.string), "{language}");
            assert_eq!(color_of(&styles, code, "-old line"), Some(syntax.tag), "{language}");
        }
    }

    #[test]
    fn a_shell_fence_reads_as_bash() {
        register_languages();
        let syntax = SyntaxPalette::for_palette(ThemePalette::Default, ThemeMode::Dark);
        let theme = highlight_theme(ThemePalette::Default, ThemeMode::Dark);
        let code = "# list\nls -la 'my dir'\n";
        for language in ["bash", "sh", "shell", "zsh"] {
            let styles = highlight(language, code, &theme);
            assert_eq!(color_of(&styles, code, "# list"), Some(syntax.comment), "{language}");
            assert_eq!(color_of(&styles, code, "'my dir'"), Some(syntax.string), "{language}");
        }
    }

    /// A line of each language, and what its words take: the grammars'
    /// names land on the roles [`crate::theme::SYNTAX_NAMES`] gives them.
    #[test]
    fn each_language_s_words_take_their_roles() {
        use crate::theme::SyntaxRole::{self, *};
        register_languages();
        let cases: [(&str, &str, &[(&str, SyntaxRole)]); 6] = [
            (
                "rust",
                "// hello\nfn greet(name: &str) -> String { format!(\"hi {name}\") }",
                &[
                    ("// hello", Comment),
                    ("fn", Keyword),
                    ("greet", Function),
                    ("String", TypeName),
                    ("\"hi {name}\"", String),
                ],
            ),
            (
                "ts",
                "// count\nconst total: number = 42; let s = 'x';",
                &[("// count", Comment), ("const", Keyword), ("42", Constant), ("'x'", String)],
            ),
            (
                "python",
                "def run():  # go\n    return \"ok\"",
                &[("def", Keyword), ("# go", Comment), ("\"ok\"", String)],
            ),
            (
                "json",
                "{\"name\": \"maka\", \"count\": 3, \"ok\": true}",
                &[("\"maka\"", String), ("3", Constant), ("true", Constant)],
            ),
            ("html", "<a href=\"/x\">link</a>", &[("a", Tag), ("href", Attribute), ("/x", String)]),
            ("css", ".box { color: red; }", &[("color", Property)]),
        ];
        let mut failures = Vec::new();
        for palette in [ThemePalette::Default, ThemePalette::CatppuccinMocha] {
            for mode in [ThemeMode::Light, ThemeMode::Dark] {
                let syntax = SyntaxPalette::for_palette(palette, mode);
                let theme = highlight_theme(palette, mode);
                for (language, code, words) in cases {
                    let styles = highlight(language, code, &theme);
                    for &(word, role) in words {
                        if color_of(&styles, code, word) != Some(role.color(&syntax)) {
                            failures.push(format!("{language}: {word} {:?}", styles));
                        }
                    }
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
