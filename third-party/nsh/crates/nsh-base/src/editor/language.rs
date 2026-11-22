//! Per-language editing rules: comments, brackets, the pairs typing closes,
//! word characters, indentation and the syntax the highlighter uses.
//!
//! The table is static data: languages are looked up by name, alias, file
//! extension or file name (`language`). Indentation rules are plain string
//! checks over the line with its trailing comment removed, so they cost no
//! regex compilation and no allocation.

use std::fmt;

/// A language's indentation rule: `raw` is the whole line, `code` the line
/// without its trailing comment, trimmed at both ends.
pub(crate) type Rule = fn(raw: &str, code: &str) -> bool;

/// What editing a language's text needs to know.
pub(crate) struct LanguageConfig {
    /// The name shown and passed on: "Rust", "TypeScript", "Plain Text".
    pub(crate) name: &'static str,
    /// An extension the highlighter's syntax set resolves (`find_syntax_by_extension`): "rs", "tsx", "sh"; empty
    /// for plain text.
    pub(crate) syntax_hint: &'static str,
    /// Other names apps and tools (LSP language ids, Markdown fences) use: "typescriptreact", "golang", "bash".
    pub(crate) aliases: &'static [&'static str],
    /// File extensions, without the dot.
    pub(crate) extensions: &'static [&'static str],
    /// Whole file names: "Makefile", "Dockerfile", ".bashrc".
    pub(crate) file_names: &'static [&'static str],
    /// "//", "#", "--".
    pub(crate) line_comment: Option<&'static str>,
    /// "/*" and "*/", "<!--" and "-->".
    pub(crate) block_comment: Option<(&'static str, &'static str)>,
    /// The pairs bracket matching and indentation use.
    pub(crate) brackets: &'static [(char, char)],
    /// The pairs typing an opening char closes: brackets and quotes.
    pub(crate) auto_close: &'static [(char, char)],
    /// Extra word characters besides letters, digits and `_` ("$" in JS, "-" in CSS).
    pub(crate) word_chars: &'static str,
    /// The language's files are indented with tabs (Go, Makefile).
    pub(crate) hard_tabs: bool,
    /// The usual indent width.
    pub(crate) tab_size: u32,
    /// The quotes that open strings on one line, so a comment marker inside a string is not taken for a comment
    /// (Rust leaves `'` out: lifetimes).
    pub(crate) string_quotes: &'static str,
    /// What indents the next line besides an opening bracket at the end.
    pub(crate) indent_rule: Option<Rule>,
    /// What outdents a line besides a closing bracket at its start.
    pub(crate) outdent_rule: Option<Rule>,
}

impl fmt::Debug for LanguageConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("LanguageConfig").field(&self.name).finish()
    }
}

impl PartialEq for LanguageConfig {
    fn eq(&self, other: &LanguageConfig) -> bool {
        self.name == other.name
    }
}

impl Eq for LanguageConfig {}

impl LanguageConfig {
    /// A line ending this way indents the next one (an opening bracket at the end, Python's `:`, Ruby's `do`, ...).
    pub(crate) fn indents_after(&self, line: &str) -> bool {
        let code = self.code(line);
        if let Some(last) = code.chars().next_back()
            && self.brackets.iter().any(|&(open, _)| open == last)
        {
            return true;
        }
        !code.is_empty() && self.indent_rule.is_some_and(|rule| rule(line, code))
    }

    /// A line starting this way (after its indentation) outdents itself (a closing bracket, `end`, `else`, ...).
    pub(crate) fn outdents(&self, line: &str) -> bool {
        let text = line.trim_start();
        if let Some(first) = text.chars().next()
            && self.brackets.iter().any(|&(_, close)| close == first)
        {
            return true;
        }
        !text.is_empty()
            && self
                .outdent_rule
                .is_some_and(|rule| rule(line, text.trim_end()))
    }

    /// Whether typing `open` auto-closes before `next` (the char after the caret): only before whitespace, the end of
    /// the line, or a closing bracket / quote, and quotes not right after a word character.
    pub(crate) fn should_auto_close(
        &self,
        open: char,
        prev: Option<char>,
        next: Option<char>,
    ) -> bool {
        let Some(&(_, close)) = self.auto_close.iter().find(|&&(o, _)| o == open) else {
            return false;
        };
        let before_ok = match next {
            None => true,
            Some(c) => {
                c.is_whitespace()
                    || ";:.,=>".contains(c)
                    || self.brackets.iter().any(|&(_, b)| b == c)
                    || self.auto_close.iter().any(|&(_, b)| b == c)
            }
        };
        if !before_ok {
            return false;
        }
        // A quote right after a word is an apostrophe or a string prefix being closed, not a new string.
        open != close || !prev.is_some_and(|c| self.is_word_char(c))
    }

    /// Letters, digits, `_` and the language's `word_chars`.
    pub(crate) fn is_word_char(&self, c: char) -> bool {
        c.is_alphanumeric() || c == '_' || self.word_chars.contains(c)
    }

    /// The line without its trailing comment (a line comment outside strings, or a block comment closing the
    /// line), trimmed.
    fn code<'a>(&self, line: &'a str) -> &'a str {
        let mut code = line;
        if let Some(marker) = self.line_comment
            && let Some(at) = self.comment_start(line, marker)
        {
            code = &line[..at];
        }
        code = code.trim();
        if let Some((open, close)) = self.block_comment
            && code.ends_with(close)
            && let Some(at) = code[..code.len() - close.len()].rfind(open)
        {
            code = code[..at].trim_end();
        }
        code
    }

    /// The byte offset of `marker` outside strings, if the line has one.
    fn comment_start(&self, line: &str, marker: &str) -> Option<usize> {
        let mut quote: Option<char> = None;
        let mut escaped = false;
        let mut prev: Option<char> = None;
        for (at, c) in line.char_indices() {
            match quote {
                Some(q) => {
                    if escaped {
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == q {
                        quote = None;
                    }
                }
                None => {
                    if line[at..].starts_with(marker)
                        // `#` starts a comment only as a word of its own (shell `$#`, `${#a}`, Nix `a#b`).
                        && (marker != "#" || prev.is_none_or(char::is_whitespace))
                    {
                        return Some(at);
                    }
                    if self.string_quotes.contains(c) {
                        quote = Some(c);
                    }
                }
            }
            prev = Some(c);
        }
        None
    }
}

// Shared values.

const BRACKETS: &[(char, char)] = &[('(', ')'), ('[', ']'), ('{', '}')];
const PAIRS: &[(char, char)] = &[('(', ')'), ('[', ']'), ('{', '}'), ('"', '"'), ('\'', '\'')];
const PAIRS_BACKTICK: &[(char, char)] = &[
    ('(', ')'),
    ('[', ']'),
    ('{', '}'),
    ('"', '"'),
    ('\'', '\''),
    ('`', '`'),
];
const PAIRS_DOUBLE: &[(char, char)] = &[('(', ')'), ('[', ']'), ('{', '}'), ('"', '"')];
const C_BLOCK: Option<(&str, &str)> = Some(("/*", "*/"));
const HTML_BLOCK: Option<(&str, &str)> = Some(("<!--", "-->"));

/// A brace language with `//` and `/* */` comments: most languages start from it.
const C_LIKE: LanguageConfig = LanguageConfig {
    name: "",
    syntax_hint: "",
    aliases: &[],
    extensions: &[],
    file_names: &[],
    line_comment: Some("//"),
    block_comment: C_BLOCK,
    brackets: BRACKETS,
    auto_close: PAIRS,
    word_chars: "",
    hard_tabs: false,
    tab_size: 4,
    string_quotes: "\"'",
    indent_rule: None,
    outdent_rule: None,
};

/// A language with `#` comments.
const HASH: LanguageConfig = LanguageConfig {
    line_comment: Some("#"),
    block_comment: None,
    ..C_LIKE
};

/// A markup language of tags.
const MARKUP: LanguageConfig = LanguageConfig {
    line_comment: None,
    block_comment: HTML_BLOCK,
    tab_size: 2,
    indent_rule: Some(html_indent),
    outdent_rule: Some(tag_outdent),
    ..C_LIKE
};

// The table.

/// Text without a language: brackets match, nothing else.
pub(crate) static PLAIN_TEXT: LanguageConfig = LanguageConfig {
    name: "Plain Text",
    aliases: &["text", "plaintext", "plain"],
    extensions: &["txt"],
    line_comment: None,
    block_comment: None,
    // Quotes stay unpaired: prose is full of apostrophes.
    auto_close: BRACKETS,
    string_quotes: "",
    ..C_LIKE
};

static RUST: LanguageConfig = LanguageConfig {
    name: "Rust",
    syntax_hint: "rs",
    extensions: &["rs"],
    auto_close: PAIRS_DOUBLE,
    string_quotes: "\"",
    ..C_LIKE
};

const JAVASCRIPT: LanguageConfig = LanguageConfig {
    name: "JavaScript",
    syntax_hint: "js",
    aliases: &["js", "node"],
    extensions: &["js", "mjs", "cjs"],
    auto_close: PAIRS_BACKTICK,
    word_chars: "$",
    tab_size: 2,
    string_quotes: "\"'`",
    ..C_LIKE
};

const JSX: LanguageConfig = LanguageConfig {
    name: "JSX",
    // The TSX grammar reads JSX: the syntax set's JavaScript grammar has no JSX.
    syntax_hint: "tsx",
    aliases: &["javascriptreact"],
    extensions: &["jsx"],
    indent_rule: Some(jsx_indent),
    outdent_rule: Some(tag_outdent),
    ..JAVASCRIPT
};

static TYPESCRIPT: LanguageConfig = LanguageConfig {
    name: "TypeScript",
    syntax_hint: "ts",
    aliases: &["ts"],
    extensions: &["ts", "mts", "cts"],
    ..JAVASCRIPT
};

static TSX: LanguageConfig = LanguageConfig {
    name: "TSX",
    syntax_hint: "tsx",
    aliases: &["typescriptreact"],
    extensions: &["tsx"],
    ..JSX
};

static JSON: LanguageConfig = LanguageConfig {
    name: "JSON",
    syntax_hint: "json",
    aliases: &["jsonc", "json5"],
    extensions: &["json", "jsonc", "json5", "jsonl", "geojson", "webmanifest"],
    file_names: &[
        ".babelrc",
        ".eslintrc",
        ".prettierrc",
        "composer.lock",
        "Pipfile.lock",
    ],
    auto_close: PAIRS_DOUBLE,
    tab_size: 2,
    string_quotes: "\"",
    ..C_LIKE
};

static PYTHON: LanguageConfig = LanguageConfig {
    name: "Python",
    syntax_hint: "py",
    aliases: &["py", "python3"],
    extensions: &["py", "pyw", "pyi", "py3"],
    block_comment: None,
    indent_rule: Some(ends_with_colon),
    outdent_rule: Some(python_outdent),
    ..HASH
};

static GO: LanguageConfig = LanguageConfig {
    name: "Go",
    syntax_hint: "go",
    aliases: &["golang"],
    extensions: &["go"],
    auto_close: PAIRS_BACKTICK,
    hard_tabs: true,
    string_quotes: "\"'`",
    ..C_LIKE
};

static C: LanguageConfig = LanguageConfig {
    name: "C",
    syntax_hint: "c",
    extensions: &["c", "h"],
    ..C_LIKE
};

static CPP: LanguageConfig = LanguageConfig {
    name: "C++",
    syntax_hint: "cpp",
    aliases: &["cpp", "c++", "cxx"],
    extensions: &[
        "cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++", "ipp", "inl",
    ],
    ..C_LIKE
};

static CSHARP: LanguageConfig = LanguageConfig {
    name: "C#",
    syntax_hint: "cs",
    aliases: &["csharp", "cs"],
    extensions: &["cs", "csx"],
    ..C_LIKE
};

static JAVA: LanguageConfig = LanguageConfig {
    name: "Java",
    syntax_hint: "java",
    extensions: &["java"],
    ..C_LIKE
};

static KOTLIN: LanguageConfig = LanguageConfig {
    name: "Kotlin",
    syntax_hint: "kt",
    aliases: &["kt"],
    extensions: &["kt", "kts"],
    ..C_LIKE
};

static SWIFT: LanguageConfig = LanguageConfig {
    name: "Swift",
    syntax_hint: "swift",
    extensions: &["swift"],
    ..C_LIKE
};

static OBJECTIVE_C: LanguageConfig = LanguageConfig {
    name: "Objective-C",
    syntax_hint: "m",
    aliases: &["objc", "objective-c", "obj-c", "objectivec"],
    extensions: &["m"],
    ..C_LIKE
};

static OBJECTIVE_CPP: LanguageConfig = LanguageConfig {
    name: "Objective-C++",
    syntax_hint: "mm",
    aliases: &["objcpp", "objective-cpp", "objc++"],
    extensions: &["mm"],
    ..C_LIKE
};

static RUBY: LanguageConfig = LanguageConfig {
    name: "Ruby",
    syntax_hint: "rb",
    aliases: &["rb"],
    extensions: &["rb", "rake", "gemspec", "ru", "erb"],
    file_names: &[
        "Gemfile",
        "Rakefile",
        "Podfile",
        "Fastfile",
        "Vagrantfile",
        "Brewfile",
    ],
    word_chars: "?!",
    tab_size: 2,
    indent_rule: Some(ruby_indent),
    outdent_rule: Some(ruby_outdent),
    ..HASH
};

static PHP: LanguageConfig = LanguageConfig {
    name: "PHP",
    syntax_hint: "php",
    extensions: &["php", "phtml", "php3", "php4", "php5", "phps"],
    auto_close: PAIRS_BACKTICK,
    word_chars: "$",
    ..C_LIKE
};

static LUA: LanguageConfig = LanguageConfig {
    name: "Lua",
    syntax_hint: "lua",
    extensions: &["lua"],
    line_comment: Some("--"),
    block_comment: Some(("--[[", "]]")),
    tab_size: 2,
    indent_rule: Some(lua_indent),
    outdent_rule: Some(lua_outdent),
    ..C_LIKE
};

static SHELL: LanguageConfig = LanguageConfig {
    name: "Shell",
    syntax_hint: "sh",
    aliases: &[
        "sh",
        "bash",
        "zsh",
        "shellscript",
        "shell-script",
        "console",
    ],
    extensions: &["sh", "bash", "zsh", "ksh", "ash"],
    file_names: &[
        ".bashrc",
        ".bash_profile",
        ".bash_aliases",
        ".bash_logout",
        ".profile",
        ".zshrc",
        ".zprofile",
        ".zshenv",
        ".zlogin",
        ".envrc",
        "PKGBUILD",
    ],
    auto_close: PAIRS_BACKTICK,
    tab_size: 2,
    string_quotes: "\"'`",
    indent_rule: Some(shell_indent),
    outdent_rule: Some(shell_outdent),
    ..HASH
};

static POWERSHELL: LanguageConfig = LanguageConfig {
    name: "PowerShell",
    // The syntax set's PowerShell grammar needs Oniguruma: with the fancy-regex set this hint resolves to nothing,
    // and the text stays plain.
    syntax_hint: "ps1",
    aliases: &["pwsh", "ps", "ps1"],
    extensions: &["ps1", "psm1", "psd1"],
    block_comment: Some(("<#", "#>")),
    auto_close: PAIRS,
    word_chars: "$-",
    ..HASH
};

static SQL: LanguageConfig = LanguageConfig {
    name: "SQL",
    syntax_hint: "sql",
    aliases: &["mysql", "postgres", "postgresql", "sqlite", "plsql", "tsql"],
    extensions: &["sql", "ddl", "dml"],
    line_comment: Some("--"),
    auto_close: PAIRS_BACKTICK,
    string_quotes: "\"'`",
    ..C_LIKE
};

static HTML: LanguageConfig = LanguageConfig {
    name: "HTML",
    syntax_hint: "html",
    aliases: &["xhtml"],
    extensions: &["html", "htm", "xhtml", "shtml"],
    word_chars: "-",
    ..MARKUP
};

static XML: LanguageConfig = LanguageConfig {
    name: "XML",
    syntax_hint: "xml",
    aliases: &["svg", "plist"],
    extensions: &[
        "xml",
        "xsd",
        "xsl",
        "xslt",
        "svg",
        "plist",
        "xaml",
        "csproj",
        "fsproj",
        "vbproj",
        "props",
        "targets",
        "resx",
        "storyboard",
        "xib",
        "rss",
        "atom",
        "xliff",
        "xlf",
    ],
    indent_rule: Some(xml_indent),
    ..MARKUP
};

const VUE: LanguageConfig = LanguageConfig {
    name: "Vue",
    syntax_hint: "vue",
    extensions: &["vue"],
    auto_close: PAIRS_BACKTICK,
    word_chars: "-",
    ..MARKUP
};

static SVELTE: LanguageConfig = LanguageConfig {
    name: "Svelte",
    syntax_hint: "svelte",
    extensions: &["svelte"],
    ..VUE
};

const CSS: LanguageConfig = LanguageConfig {
    name: "CSS",
    syntax_hint: "css",
    extensions: &["css"],
    line_comment: None,
    word_chars: "-",
    tab_size: 2,
    ..C_LIKE
};

const SCSS: LanguageConfig = LanguageConfig {
    name: "SCSS",
    syntax_hint: "scss",
    extensions: &["scss"],
    line_comment: Some("//"),
    word_chars: "-$",
    ..CSS
};

static SASS: LanguageConfig = LanguageConfig {
    name: "Sass",
    syntax_hint: "sass",
    extensions: &["sass"],
    word_chars: "-$",
    ..SCSS
};

static LESS: LanguageConfig = LanguageConfig {
    name: "Less",
    syntax_hint: "less",
    extensions: &["less"],
    word_chars: "-@",
    ..SCSS
};

static MARKDOWN: LanguageConfig = LanguageConfig {
    name: "Markdown",
    syntax_hint: "md",
    aliases: &["md", "gfm"],
    extensions: &["md", "markdown", "mdown", "mkd", "mkdn", "mdx"],
    line_comment: None,
    block_comment: HTML_BLOCK,
    // Backticks pair for inline code; apostrophes in prose stay unpaired.
    auto_close: &[('(', ')'), ('[', ']'), ('{', '}'), ('"', '"'), ('`', '`')],
    tab_size: 2,
    string_quotes: "",
    ..C_LIKE
};

static YAML: LanguageConfig = LanguageConfig {
    name: "YAML",
    syntax_hint: "yaml",
    aliases: &["yml"],
    extensions: &["yaml", "yml"],
    file_names: &[".clang-format", ".clangd"],
    tab_size: 2,
    indent_rule: Some(yaml_indent),
    ..HASH
};

static TOML: LanguageConfig = LanguageConfig {
    name: "TOML",
    syntax_hint: "toml",
    extensions: &["toml"],
    file_names: &["Cargo.lock", "Pipfile", "poetry.lock", "uv.lock"],
    ..HASH
};

static DOCKERFILE: LanguageConfig = LanguageConfig {
    name: "Dockerfile",
    syntax_hint: "dockerfile",
    aliases: &["docker", "containerfile"],
    extensions: &["dockerfile", "containerfile"],
    file_names: &["Dockerfile", "Containerfile"],
    ..HASH
};

static MAKEFILE: LanguageConfig = LanguageConfig {
    name: "Makefile",
    syntax_hint: "make",
    aliases: &["make", "makefile"],
    extensions: &["mk", "mak", "make"],
    file_names: &[
        "Makefile",
        "makefile",
        "GNUmakefile",
        "Makefile.am",
        "Makefile.in",
    ],
    hard_tabs: true,
    indent_rule: Some(make_indent),
    ..HASH
};

static DART: LanguageConfig = LanguageConfig {
    name: "Dart",
    syntax_hint: "dart",
    extensions: &["dart"],
    tab_size: 2,
    ..C_LIKE
};

static SCALA: LanguageConfig = LanguageConfig {
    name: "Scala",
    syntax_hint: "scala",
    extensions: &["scala", "sc", "sbt"],
    tab_size: 2,
    ..C_LIKE
};

static ELIXIR: LanguageConfig = LanguageConfig {
    name: "Elixir",
    syntax_hint: "ex",
    aliases: &["ex", "exs"],
    extensions: &["ex", "exs"],
    file_names: &["mix.lock"],
    word_chars: "?!",
    tab_size: 2,
    indent_rule: Some(elixir_indent),
    outdent_rule: Some(elixir_outdent),
    ..HASH
};

static HASKELL: LanguageConfig = LanguageConfig {
    name: "Haskell",
    syntax_hint: "hs",
    aliases: &["hs"],
    extensions: &["hs", "hs-boot", "hsig"],
    line_comment: Some("--"),
    block_comment: Some(("{-", "-}")),
    // `'` is a name character (`x'`), and char literals are rare enough to type by hand.
    auto_close: PAIRS_DOUBLE,
    word_chars: "'",
    tab_size: 2,
    string_quotes: "\"",
    indent_rule: Some(haskell_indent),
    ..C_LIKE
};

static ZIG: LanguageConfig = LanguageConfig {
    name: "Zig",
    syntax_hint: "zig",
    extensions: &["zig", "zon"],
    block_comment: None,
    auto_close: PAIRS_DOUBLE,
    ..C_LIKE
};

static GRAPHQL: LanguageConfig = LanguageConfig {
    name: "GraphQL",
    syntax_hint: "graphql",
    aliases: &["gql"],
    extensions: &["graphql", "graphqls", "gql"],
    auto_close: PAIRS_DOUBLE,
    tab_size: 2,
    string_quotes: "\"",
    ..HASH
};

static DIFF: LanguageConfig = LanguageConfig {
    name: "Diff",
    syntax_hint: "diff",
    aliases: &["patch", "udiff"],
    extensions: &["diff", "patch", "rej"],
    line_comment: None,
    block_comment: None,
    // Every char of a diff line is the text's own: nothing pairs or indents.
    brackets: &[],
    auto_close: &[],
    string_quotes: "",
    ..C_LIKE
};

static PERL: LanguageConfig = LanguageConfig {
    name: "Perl",
    syntax_hint: "pl",
    extensions: &["pl", "pm", "t", "pod"],
    word_chars: "$@%",
    ..HASH
};

static R: LanguageConfig = LanguageConfig {
    name: "R",
    syntax_hint: "r",
    extensions: &["r", "rprofile"],
    file_names: &[".Rprofile"],
    tab_size: 2,
    ..HASH
};

static JULIA: LanguageConfig = LanguageConfig {
    name: "Julia",
    syntax_hint: "jl",
    aliases: &["jl"],
    extensions: &["jl"],
    block_comment: Some(("#=", "=#")),
    indent_rule: Some(julia_indent),
    outdent_rule: Some(lua_outdent),
    ..HASH
};

static ERLANG: LanguageConfig = LanguageConfig {
    name: "Erlang",
    syntax_hint: "erl",
    aliases: &["erl"],
    extensions: &["erl", "hrl"],
    line_comment: Some("%"),
    block_comment: None,
    indent_rule: Some(ends_with_arrow),
    ..C_LIKE
};

static CLOJURE: LanguageConfig = LanguageConfig {
    name: "Clojure",
    syntax_hint: "clj",
    aliases: &["clj"],
    extensions: &["clj", "cljs", "cljc", "edn"],
    line_comment: Some(";"),
    block_comment: None,
    // `'` quotes a form: `'(1 2)`.
    auto_close: PAIRS_DOUBLE,
    word_chars: "-?!*+<>=/.",
    tab_size: 2,
    string_quotes: "\"",
    ..C_LIKE
};

const OCAML: LanguageConfig = LanguageConfig {
    name: "OCaml",
    syntax_hint: "ml",
    extensions: &["ml", "mli"],
    line_comment: None,
    block_comment: Some(("(*", "*)")),
    auto_close: PAIRS_DOUBLE,
    word_chars: "'",
    tab_size: 2,
    string_quotes: "\"",
    ..C_LIKE
};

static FSHARP: LanguageConfig = LanguageConfig {
    name: "F#",
    syntax_hint: "fs",
    aliases: &["fsharp"],
    extensions: &["fs", "fsi", "fsx"],
    block_comment: Some(("(*", "*)")),
    ..OCAML
};

static NIX: LanguageConfig = LanguageConfig {
    name: "Nix",
    syntax_hint: "nix",
    extensions: &["nix"],
    block_comment: C_BLOCK,
    word_chars: "-'",
    auto_close: PAIRS_DOUBLE,
    tab_size: 2,
    string_quotes: "\"",
    ..HASH
};

static FISH: LanguageConfig = LanguageConfig {
    name: "Fish",
    syntax_hint: "fish",
    extensions: &["fish"],
    indent_rule: Some(fish_indent),
    outdent_rule: Some(fish_outdent),
    ..HASH
};

static PROTOBUF: LanguageConfig = LanguageConfig {
    name: "Protocol Buffers",
    syntax_hint: "proto",
    aliases: &["proto", "protobuf"],
    extensions: &["proto"],
    tab_size: 2,
    ..C_LIKE
};

static TERRAFORM: LanguageConfig = LanguageConfig {
    name: "Terraform",
    syntax_hint: "tf",
    aliases: &["hcl", "tf"],
    extensions: &["tf", "tfvars", "hcl"],
    block_comment: C_BLOCK,
    auto_close: PAIRS_DOUBLE,
    tab_size: 2,
    string_quotes: "\"",
    ..HASH
};

static INI: LanguageConfig = LanguageConfig {
    name: "INI",
    syntax_hint: "ini",
    aliases: &["properties", "dosini"],
    extensions: &["ini", "cfg", "conf", "properties", "inf"],
    file_names: &[".editorconfig", ".gitconfig", ".npmrc"],
    line_comment: Some(";"),
    block_comment: None,
    ..C_LIKE
};

static CMAKE: LanguageConfig = LanguageConfig {
    name: "CMake",
    syntax_hint: "cmake",
    extensions: &["cmake"],
    file_names: &["CMakeLists.txt"],
    auto_close: PAIRS_DOUBLE,
    string_quotes: "\"",
    ..HASH
};

/// Every language, in lookup order (the first one wins a shared extension: `h` is C's).
static LANGUAGES: &[&LanguageConfig] = &[
    &PLAIN_TEXT,
    &RUST,
    &JAVASCRIPT,
    &JSX,
    &TYPESCRIPT,
    &TSX,
    &JSON,
    &PYTHON,
    &GO,
    &C,
    &CPP,
    &CSHARP,
    &JAVA,
    &KOTLIN,
    &SWIFT,
    &OBJECTIVE_C,
    &OBJECTIVE_CPP,
    &RUBY,
    &PHP,
    &LUA,
    &SHELL,
    &POWERSHELL,
    &SQL,
    &HTML,
    &XML,
    &VUE,
    &SVELTE,
    &CSS,
    &SCSS,
    &SASS,
    &LESS,
    &MARKDOWN,
    &YAML,
    &TOML,
    &DOCKERFILE,
    &MAKEFILE,
    &DART,
    &SCALA,
    &ELIXIR,
    &HASKELL,
    &ZIG,
    &GRAPHQL,
    &DIFF,
    &PERL,
    &R,
    &JULIA,
    &ERLANG,
    &CLOJURE,
    &OCAML,
    &FSHARP,
    &NIX,
    &FISH,
    &PROTOBUF,
    &TERRAFORM,
    &INI,
    &CMAKE,
];

/// The language a name, alias or file extension names, case-insensitive ("rust", "rs", "main.rs", "tsx",
/// "typescriptreact", "py", "Makefile", "Dockerfile"); plain text for anything else and the empty string.
pub(crate) fn language(name: &str) -> &'static LanguageConfig {
    let name = name.trim();
    if name.is_empty() {
        return &PLAIN_TEXT;
    }
    let is = |s: &&str| s.eq_ignore_ascii_case(name);
    if let Some(found) = LANGUAGES.iter().find(|l| {
        l.name.eq_ignore_ascii_case(name) || l.aliases.iter().any(is) || l.extensions.iter().any(is)
    }) {
        return found;
    }
    // A path: its file name, then its extensions from the longest ("foo.d.ts": "d.ts", then "ts").
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    if base.is_empty() {
        return &PLAIN_TEXT;
    }
    if let Some(found) = LANGUAGES
        .iter()
        .find(|l| l.file_names.iter().any(|f| f.eq_ignore_ascii_case(base)))
    {
        return found;
    }
    for (at, _) in base.match_indices('.') {
        let ext = &base[at + 1..];
        if let Some(found) = LANGUAGES
            .iter()
            .find(|l| l.extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)))
        {
            return found;
        }
    }
    // Variants named after the file: "Dockerfile.dev", "Makefile.local".
    let stem = base.split('.').next().unwrap_or(base);
    if stem.eq_ignore_ascii_case("dockerfile") || stem.eq_ignore_ascii_case("containerfile") {
        return &DOCKERFILE;
    }
    if stem.eq_ignore_ascii_case("makefile") {
        return &MAKEFILE;
    }
    &PLAIN_TEXT
}

// Indentation rules.

/// Whether `text` starts with the word `word` (not a longer word: `end` but not `endpoint`).
fn starts_with_word(text: &str, word: &str) -> bool {
    text.strip_prefix(word)
        .is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
}

/// Whether `text` ends with the word `word` (not a longer word: `do` but not `todo`, nor `obj.do`).
fn ends_with_word(text: &str, word: &str) -> bool {
    text.strip_suffix(word)
        .is_some_and(|rest| !rest.ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.'))
}

fn starts_with_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| starts_with_word(text, w))
}

fn ends_with_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| ends_with_word(text, w))
}

/// `code` without a trailing `|params|` (Ruby's `do |x|`, `{ |a, b|`).
fn strip_block_params(code: &str) -> &str {
    if let Some(inner) = code.strip_suffix('|')
        && let Some(at) = inner.rfind('|')
    {
        return inner[..at].trim_end();
    }
    code
}

fn ends_with_colon(_: &str, code: &str) -> bool {
    code.ends_with(':')
}

fn ends_with_arrow(_: &str, code: &str) -> bool {
    code.ends_with("->")
}

fn python_outdent(_: &str, text: &str) -> bool {
    starts_with_any(text, &["else", "elif", "except", "finally"])
}

fn yaml_indent(_: &str, code: &str) -> bool {
    // `key:`, a block scalar (`key: |`, `- >-`), or a bare `-` list item.
    let item = |head: &str| head.ends_with(':') || head == "-" || head.ends_with(" -");
    if item(code) {
        return true;
    }
    code.trim_end_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '+')
        .strip_suffix(['|', '>'])
        .is_some_and(|head| item(head.trim_end()))
}

const RUBY_OPENERS: &[&str] = &[
    "def", "class", "module", "if", "unless", "while", "until", "for", "case", "begin", "else",
    "elsif", "when", "in", "rescue", "ensure",
];

fn ruby_indent(_: &str, code: &str) -> bool {
    let code = strip_block_params(code);
    if ends_with_word(code, "do") || code.ends_with('{') {
        return true;
    }
    // A block opener whose block does not close on the same line (`def f; end`), and not an endless `def f = x`.
    starts_with_any(code, RUBY_OPENERS)
        && !ends_with_word(code, "end")
        && !(starts_with_word(code, "def")
            && (code.contains(") = ") || (!code.contains('(') && code.contains(" = "))))
}

fn ruby_outdent(_: &str, text: &str) -> bool {
    starts_with_any(
        text,
        &["end", "else", "elsif", "when", "in", "rescue", "ensure"],
    )
}

fn lua_indent(_: &str, code: &str) -> bool {
    if ends_with_any(code, &["then", "do", "else", "repeat"]) {
        return true;
    }
    // `function f(a)`, `local f = function(a)`.
    code.ends_with(')')
        && code
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .any(|w| w == "function")
}

fn lua_outdent(_: &str, text: &str) -> bool {
    starts_with_any(text, &["end", "else", "elseif", "until"])
}

fn shell_indent(_: &str, code: &str) -> bool {
    let code = code.strip_suffix(";;").unwrap_or(code).trim_end();
    // `then`, `do`, `else`, `case x in`, a case item `a|b)`.
    ends_with_any(code, &["then", "do", "else", "in"])
        || (code.ends_with(')') && !code.contains('(') && !code.starts_with('$'))
}

fn shell_outdent(_: &str, text: &str) -> bool {
    starts_with_any(text, &["fi", "done", "esac", "else", "elif"])
}

fn fish_indent(_: &str, code: &str) -> bool {
    starts_with_any(
        code,
        &[
            "function", "if", "else", "while", "for", "switch", "case", "begin",
        ],
    ) && !ends_with_word(code, "end")
}

fn fish_outdent(_: &str, text: &str) -> bool {
    starts_with_any(text, &["end", "else", "case"])
}

fn elixir_indent(_: &str, code: &str) -> bool {
    ends_with_any(code, &["do", "else", "after", "rescue", "catch", "fn"]) || code.ends_with("->")
}

fn elixir_outdent(_: &str, text: &str) -> bool {
    starts_with_any(text, &["end", "else", "after", "rescue", "catch"])
}

fn haskell_indent(_: &str, code: &str) -> bool {
    ends_with_any(code, &["where", "do", "of", "let", "then", "else"])
        || (code.ends_with('=') && !code.ends_with("=="))
}

fn julia_indent(_: &str, code: &str) -> bool {
    ends_with_word(code, "do")
        || (starts_with_any(
            code,
            &[
                "function", "if", "elseif", "else", "for", "while", "begin", "let", "module",
                "struct", "mutable", "try", "catch", "finally", "macro", "quote",
            ],
        ) && !ends_with_word(code, "end"))
}

fn make_indent(raw: &str, code: &str) -> bool {
    // A rule (`target: deps`) at the start of a line; `x := y` and `x ::= y` are assignments.
    if raw.starts_with(char::is_whitespace) {
        return false;
    }
    let Some(colon) = code.find(':') else {
        return false;
    };
    !code[..colon].contains('=')
        && !code[colon..].starts_with(":=")
        && !code[colon..].starts_with("::=")
}

/// HTML's elements without an end tag.
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// The name of the opening tag that ends `code` and is left open, or None. `""` is a fragment (`<>`).
fn open_tag_at_end(code: &str) -> Option<&str> {
    let tag_end = code.strip_suffix('>')?;
    // An arrow (`() =>`), not a tag.
    if tag_end.ends_with('=') || tag_end.ends_with('-') || tag_end.ends_with('/') {
        return None;
    }
    let at = tag_end.rfind('<')?;
    // A comparison or a type argument (`Array<T>`), not a tag: a tag follows no name.
    if code[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$' || c == '.') {
        return None;
    }
    let inner = &tag_end[at + 1..];
    // A closing tag, `<?xml ?>`, `<!DOCTYPE>` or `<!-- -->`.
    if inner.starts_with(['/', '?', '!']) {
        return None;
    }
    let name_len = inner
        .find(|c: char| !(c.is_alphanumeric() || matches!(c, '-' | ':' | '.' | '_')))
        .unwrap_or(inner.len());
    let name = &inner[..name_len];
    // A name followed by attributes or nothing; nameless only as a fragment (`a < b >` is no tag).
    let rest = &inner[name_len..];
    let attributes_follow =
        rest.is_empty() || (!name.is_empty() && rest.starts_with(char::is_whitespace));
    if !attributes_follow {
        return None;
    }
    Some(name)
}

fn xml_indent(_: &str, code: &str) -> bool {
    open_tag_at_end(code).is_some_and(|name| !name.is_empty())
}

fn html_indent(_: &str, code: &str) -> bool {
    open_tag_at_end(code).is_some_and(|name| {
        !name.is_empty() && !VOID_ELEMENTS.iter().any(|v| v.eq_ignore_ascii_case(name))
    })
}

fn jsx_indent(_: &str, code: &str) -> bool {
    open_tag_at_end(code).is_some()
}

fn tag_outdent(_: &str, text: &str) -> bool {
    text.starts_with("</") || text.starts_with("/>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_by_name_alias_extension_and_file_name() {
        assert_eq!(language("rust").name, "Rust");
        assert_eq!(language("Rust").name, "Rust");
        assert_eq!(language("rs").name, "Rust");
        assert_eq!(language("main.rs").name, "Rust");
        assert_eq!(language("src/editor/main.rs").name, "Rust");
        assert_eq!(language("C:\\src\\main.RS").name, "Rust");
        assert_eq!(language("tsx").name, "TSX");
        assert_eq!(language("typescriptreact").name, "TSX");
        assert_eq!(language("javascriptreact").name, "JSX");
        assert_eq!(language("App.jsx").name, "JSX");
        assert_eq!(language("index.d.ts").name, "TypeScript");
        assert_eq!(language("mod.mjs").name, "JavaScript");
        assert_eq!(language("py").name, "Python");
        assert_eq!(language("Makefile").name, "Makefile");
        assert_eq!(language("makefile").name, "Makefile");
        assert_eq!(language("rules.mk").name, "Makefile");
        assert_eq!(language("Dockerfile").name, "Dockerfile");
        assert_eq!(language("Dockerfile.dev").name, "Dockerfile");
        assert_eq!(language("api.dockerfile").name, "Dockerfile");
        assert_eq!(language("bash").name, "Shell");
        assert_eq!(language("zsh").name, "Shell");
        assert_eq!(language("~/.zshrc").name, "Shell");
        assert_eq!(language("golang").name, "Go");
        assert_eq!(language("c++").name, "C++");
        assert_eq!(language("C#").name, "C#");
        assert_eq!(language("csharp").name, "C#");
        assert_eq!(language("header.h").name, "C");
        assert_eq!(language("objc").name, "Objective-C");
        assert_eq!(language("Cargo.lock").name, "TOML");
        assert_eq!(language("Cargo.toml").name, "TOML");
        assert_eq!(language("CMakeLists.txt").name, "CMake");
        assert_eq!(language("notes.txt").name, "Plain Text");
        assert_eq!(language("tsconfig.jsonc").name, "JSON");
        assert_eq!(language("Gemfile").name, "Ruby");
        assert_eq!(language("App.vue").name, "Vue");
        assert_eq!(language("App.svelte").name, "Svelte");
        assert_eq!(language("schema.gql").name, "GraphQL");
        assert_eq!(language("fix.patch").name, "Diff");
        assert_eq!(language("README.md").name, "Markdown");
        assert_eq!(language("ci.yml").name, "YAML");
        assert_eq!(language("pwsh").name, "PowerShell");
    }

    #[test]
    fn unknown_and_empty_names_are_plain_text() {
        assert_eq!(language(""), &PLAIN_TEXT);
        assert_eq!(language("   "), &PLAIN_TEXT);
        assert_eq!(language("klingon"), &PLAIN_TEXT);
        assert_eq!(language("archive.unknownext"), &PLAIN_TEXT);
        assert_eq!(language("dir/"), &PLAIN_TEXT);
        assert_eq!(language("."), &PLAIN_TEXT);
        assert_eq!(language("名前.文字"), &PLAIN_TEXT);
        assert_eq!(language("プラン.rs").name, "Rust");
    }

    #[test]
    fn table_is_consistent() {
        for (i, l) in LANGUAGES.iter().enumerate() {
            assert!(!l.name.is_empty());
            // Every language finds itself by name.
            assert!(std::ptr::eq(language(l.name), *l), "{}", l.name);
            assert!(l.tab_size > 0);
            assert!(
                l.syntax_hint.is_empty() == std::ptr::eq(*l, &PLAIN_TEXT),
                "{}",
                l.name
            );
            for other in &LANGUAGES[..i] {
                assert!(
                    !other.name.eq_ignore_ascii_case(l.name),
                    "duplicate name {}",
                    l.name
                );
            }
            assert!(
                !l.syntax_hint.contains('.') && l.syntax_hint == l.syntax_hint.to_ascii_lowercase()
            );
        }
        assert!(GO.hard_tabs && MAKEFILE.hard_tabs && !RUST.hard_tabs);
        assert_eq!(TSX.tab_size, 2);
        assert_eq!(TSX.word_chars, "$");
    }

    #[test]
    fn brackets_indent_and_outdent() {
        let rust = language("rust");
        assert!(rust.indents_after("fn main() {"));
        assert!(rust.indents_after("    let v = vec!["));
        assert!(rust.indents_after("foo("));
        assert!(rust.indents_after("fn f<'a>(x: &'a str) {  // a comment"));
        assert!(rust.indents_after("if x { /* block */"));
        assert!(rust.indents_after("let s = \"// not a comment\"; {"));
        assert!(!rust.indents_after("let s = \"{\";"));
        assert!(!rust.indents_after("let x = 1; // {"));
        assert!(!rust.indents_after("{ a }"));
        assert!(!rust.indents_after(""));
        assert!(!rust.indents_after("    "));
        assert!(rust.outdents("    }"));
        assert!(rust.outdents("} else {"));
        assert!(rust.indents_after("} else {"));
        assert!(rust.outdents("\t])"));
        assert!(!rust.outdents("    x"));
        assert!(!rust.outdents(""));
        assert!(rust.indents_after("let 名前 = 「x」; {"));
        assert!(rust.indents_after("let e = \"👍🏽\"; ("));
    }

    #[test]
    fn python_and_yaml_colons() {
        let py = language("python");
        assert!(py.indents_after("def f(x):"));
        assert!(py.indents_after("    if x:  # comment"));
        assert!(py.indents_after("d = {"));
        assert!(!py.indents_after("x = 'a:'"));
        assert!(!py.indents_after("x = 1  # todo:"));
        assert!(py.outdents("    else:"));
        assert!(py.outdents("elif x:"));
        assert!(py.outdents("except ValueError:"));
        assert!(!py.outdents("elsewhere = 1"));

        let yaml = language("yaml");
        assert!(yaml.indents_after("jobs:"));
        assert!(yaml.indents_after("  script: |"));
        assert!(yaml.indents_after("  script: >-"));
        assert!(yaml.indents_after("  - |"));
        assert!(yaml.indents_after("-"));
        assert!(!yaml.indents_after("name: build"));
        assert!(!yaml.indents_after("a: b # c:"));
        assert!(!yaml.indents_after("a: b->"));
        assert!(!yaml.indents_after("port: 8080"));
    }

    #[test]
    fn keyword_languages() {
        let ruby = language("ruby");
        assert!(ruby.indents_after("def foo(a)"));
        assert!(ruby.indents_after("class Foo < Bar"));
        assert!(ruby.indents_after("items.each do |item|"));
        assert!(ruby.indents_after("items.map { |a, b|"));
        assert!(ruby.indents_after("loop do"));
        assert!(!ruby.indents_after("def foo; end"));
        assert!(!ruby.indents_after("def foo = 1"));
        assert!(!ruby.indents_after("def foo(a) = a * 2"));
        assert!(ruby.indents_after("def foo(a = 1)"));
        assert!(!ruby.indents_after("todo"));
        assert!(!ruby.indents_after("return x if y"));
        assert!(ruby.outdents("  end"));
        assert!(ruby.outdents("else"));
        assert!(!ruby.outdents("endpoint = 1"));
        assert!(!ruby.outdents("include Foo"));

        let lua = language("lua");
        assert!(lua.indents_after("if x then"));
        assert!(lua.indents_after("for i = 1, 3 do"));
        assert!(lua.indents_after("function M.foo(a, b)"));
        assert!(lua.indents_after("local f = function(a) -- note"));
        assert!(!lua.indents_after("local f = function(a) return a end"));
        assert!(!lua.indents_after("print(x)"));
        assert!(lua.outdents("end"));
        assert!(lua.outdents("  until done"));

        let sh = language("sh");
        assert!(sh.indents_after("if [ -f x ]; then"));
        assert!(sh.indents_after("for f in *.rs; do"));
        assert!(sh.indents_after("case \"$1\" in"));
        assert!(sh.indents_after("  start|run)"));
        assert!(sh.indents_after("main() {"));
        assert!(!sh.indents_after("echo $# # count"));
        assert!(!sh.indents_after("echo done"));
        assert!(sh.outdents("fi"));
        assert!(sh.outdents("  done"));
        assert!(sh.outdents("elif true; then"));
        assert!(!sh.outdents("fix"));

        let ex = language("elixir");
        assert!(ex.indents_after("defmodule Foo do"));
        assert!(ex.indents_after("  {:ok, x} ->"));
        assert!(ex.outdents("end"));

        let make = language("Makefile");
        assert!(make.indents_after("build: src/main.c"));
        assert!(make.indents_after("all:"));
        assert!(!make.indents_after("CC := gcc"));
        assert!(!make.indents_after("X = a:b"));
        assert!(!make.indents_after("\techo a: b"));
        assert!(!make.indents_after("# all:"));
    }

    #[test]
    fn tags_indent() {
        let html = language("html");
        assert!(html.indents_after("<div class=\"a\">"));
        assert!(html.indents_after("  <ul>"));
        assert!(!html.indents_after("<br>"));
        assert!(!html.indents_after("<img src=\"a.png\">"));
        assert!(!html.indents_after("<!DOCTYPE html>"));
        assert!(!html.indents_after("<p>text</p>"));
        assert!(!html.indents_after("<input/>"));
        assert!(!html.indents_after("<!-- <div> -->"));
        assert!(html.outdents("</div>"));
        assert!(html.outdents("  />"));

        let xml = language("xml");
        assert!(xml.indents_after("<plist version=\"1.0\">"));
        assert!(!xml.indents_after("<?xml version=\"1.0\"?>"));
        assert!(!xml.indents_after("<key/>"));
        assert!(!xml.indents_after("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\">"));

        let tsx = language("tsx");
        assert!(tsx.indents_after("return <View style={s}>"));
        assert!(tsx.indents_after("  <>"));
        assert!(tsx.indents_after("return ("));
        assert!(!tsx.indents_after("const f = () =>"));
        assert!(!tsx.indents_after("type A = Array<string>"));
        assert!(!tsx.indents_after("if (a < b && c >"));
        assert!(!tsx.indents_after("<Text>hi</Text>"));
        assert!(!tsx.indents_after("<Image src={a} />"));
        assert!(tsx.outdents("</View>"));
        let ts = language("ts");
        assert!(!ts.indents_after("return <View>"));
    }

    #[test]
    fn auto_close() {
        let rust = language("rust");
        assert!(rust.should_auto_close('(', None, None));
        assert!(rust.should_auto_close('(', Some('f'), None));
        assert!(rust.should_auto_close('{', Some(' '), Some(' ')));
        assert!(rust.should_auto_close('[', None, Some(')')));
        assert!(rust.should_auto_close('(', None, Some(';')));
        assert!(rust.should_auto_close('(', None, Some('\t')));
        assert!(!rust.should_auto_close('(', None, Some('x')));
        assert!(!rust.should_auto_close('(', None, Some('名')));
        assert!(rust.should_auto_close('"', Some(' '), None));
        assert!(rust.should_auto_close('"', Some('('), Some(')')));
        assert!(!rust.should_auto_close('"', Some('r'), None));
        // Lifetimes: `'` does not pair in Rust.
        assert!(!rust.should_auto_close('\'', Some('&'), None));
        assert!(!rust.should_auto_close('x', None, None));

        let ts = language("ts");
        assert!(ts.should_auto_close('`', Some('='), None));
        assert!(!ts.should_auto_close('\'', Some('$'), None));
        assert!(ts.should_auto_close('\'', Some('('), Some('"')));

        let plain = language("");
        assert!(plain.should_auto_close('(', None, None));
        assert!(!plain.should_auto_close('\'', Some(' '), None));
        assert!(!language("diff").should_auto_close('(', None, None));
        // An apostrophe in Markdown prose stays single.
        assert!(!language("md").should_auto_close('\'', Some('n'), Some('t')));
        assert!(language("md").should_auto_close('`', Some(' '), None));
    }

    #[test]
    fn word_chars() {
        assert!(language("js").is_word_char('$'));
        assert!(!language("rust").is_word_char('$'));
        assert!(language("css").is_word_char('-'));
        assert!(language("rust").is_word_char('é'));
        assert!(language("rust").is_word_char('字'));
        assert!(!language("rust").is_word_char('-'));
    }

    #[test]
    fn comment_markers() {
        assert_eq!(language("rust").line_comment, Some("//"));
        assert_eq!(language("py").line_comment, Some("#"));
        assert_eq!(language("sql").line_comment, Some("--"));
        assert_eq!(language("css").line_comment, None);
        assert_eq!(language("css").block_comment, Some(("/*", "*/")));
        assert_eq!(language("html").block_comment, Some(("<!--", "-->")));
        assert_eq!(language("").line_comment, None);
    }
}
