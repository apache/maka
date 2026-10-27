//! The built-in syntax highlighting of code blocks (feature `highlight`):
//! syntect with bat's syntaxes (two-face), in Allsum's reading palette.
//!
//! The tokens, their colors and the mapping of TextMate scopes to them are
//! `crate::syntax`'s, which the `Editor` shares. What maps to nothing keeps
//! the code's own color (the app's, from its `codeBlockCode` part).
//!
//! Parsing is slow (a fresh 500-line TSX block takes over 100 ms, the first
//! block of a language also compiles its regexes) and the engine thread
//! must not wait for it. A block is highlighted on the spot only when that
//! is cheap: it was highlighted before, it grew by what costs little to
//! parse (an AI reply streaming its code), or it is small in a language
//! measured fast. Otherwise its code shows plain at once and is highlighted
//! on a blocking thread; the colors then arrive through a signal, and only
//! that text changes (same characters, so no layout moves). The syntaxes
//! themselves load on that thread too, on the first block with a language.
//!
//! The last blocks highlighted are kept (for every engine of the process)
//! with the parser's state at the start of their last line, so a block seen
//! before costs nothing and a block that grew is parsed from its last line
//! on.

#[cfg(feature = "highlight")]
pub(super) use self::syntect_highlighter::built_in;

/// No built-in highlighter without the feature: code blocks are plain.
#[cfg(not(feature = "highlight"))]
pub(super) fn built_in(_: &super::CodeBlock) -> Option<Vec<nsh_core::element::AnyElement>> {
    None
}

#[cfg(feature = "highlight")]
mod syntect_highlighter {
    use std::{
        ops::Range,
        sync::{Mutex, MutexGuard},
    };

    use nsh_core::{prelude::*, time::Instant};
    use syntect::{
        parsing::{ParseState, ScopeStack, SyntaxReference},
        util::LinesWithEndings,
    };

    use crate::{
        syntax::{Token, find_syntax, loaded, plain, scope_token, syntaxes},
        text_view::CodeBlock,
    };

    static CACHE: Mutex<Cache> = Mutex::new(Cache {
        entries: Vec::new(),
        rates: Vec::new(),
    });

    /// How many blocks are remembered: more than a long reply holds.
    const CACHE_SIZE: usize = 64;

    /// The parsing a block may cost on the engine thread, in nanoseconds.
    const BUDGET: f64 = 2_000_000.0;

    /// The spans of a code block highlighted by the built-in highlighter,
    /// or `None` for a block it leaves plain (no language, or one syntect
    /// does not know).
    pub(in crate::text_view) fn built_in(code: &CodeBlock) -> Option<Vec<AnyElement>> {
        let language = code.language.as_deref()?.trim();
        if plain(language) {
            return None;
        }
        let source = code.code.clone();
        let partial = if loaded() {
            match now(find_syntax(language)?, &source) {
                Ok(tokens) => return Some(spans(&source, &tokens)),
                Err(partial) => partial,
            }
        } else {
            Tokens::new()
        };
        let highlighted = signal(partial);
        later(language.to_owned(), source.clone(), highlighted);
        Some(vec![dynamic(move || {
            highlighted.with(|tokens| spans(&source, tokens))
        })])
    }

    /// The tokens of `code` when they cost little to get here, else the
    /// tokens known so far (those of a part it starts with).
    fn now(syntax: &'static SyntaxReference, code: &str) -> Result<Tokens, Tokens> {
        let mut cache = lock();
        if let Some(tokens) = cache.get(syntax, code) {
            return Ok(tokens);
        }
        let mut job = cache.job(syntax, code);
        let cost = cache
            .rate(syntax)
            .map(|rate| rate * (code.len() - job.from) as f64);
        if cost.is_none_or(|cost| cost > BUDGET) {
            return Err(job.tokens);
        }
        drop(cache);
        job.run();
        let tokens = job.tokens.clone();
        lock().finish(job);
        Ok(tokens)
    }

    /// Highlights `code` off the engine thread and sets `highlighted`.
    #[cfg(not(target_arch = "wasm32"))]
    fn later(language: String, code: String, highlighted: Signal<Tokens>) {
        spawn(async move {
            if let Ok(tokens) = blocking(move || tokens(&language, &code)).await {
                highlighted.set(tokens);
            }
        });
    }

    /// WebAssembly has no threads: the block is highlighted after the
    /// frame that shows it plain.
    #[cfg(target_arch = "wasm32")]
    fn later(language: String, code: String, highlighted: Signal<Tokens>) {
        spawn(async move {
            next_frame().await;
            highlighted.set(tokens(&language, &code));
        });
    }

    /// `code` in spans styled by its tokens.
    fn spans(code: &str, tokens: &Tokens) -> Vec<AnyElement> {
        let mut out = Vec::with_capacity(tokens.len() * 2 + 1);
        let mut at = 0;
        for (range, token) in tokens {
            if range.start > at {
                out.push(text(code[at..range.start].to_owned()).into_element());
            }
            let mut span = text(code[range.clone()].to_owned());
            *span.style() = token.style();
            out.push(span.into_element());
            at = range.end;
        }
        if at < code.len() {
            out.push(text(code[at..].to_owned()).into_element());
        }
        out
    }

    /// Tokens of a block's code: byte ranges in order, not overlapping,
    /// on character boundaries (syntect's operations are), adjacent equal
    /// tokens merged.
    pub(super) type Tokens = Vec<(Range<usize>, Token)>;

    /// The tokens of `code` in `language`, however long they take; none for
    /// a language syntect does not know.
    pub(super) fn tokens(language: &str, code: &str) -> Tokens {
        syntaxes();
        let Some(syntax) = find_syntax(language) else {
            return Tokens::new();
        };
        let mut cache = lock();
        if let Some(tokens) = cache.get(syntax, code) {
            return tokens;
        }
        let mut job = cache.job(syntax, code);
        drop(cache);
        job.run();
        let tokens = job.tokens.clone();
        lock().finish(job);
        tokens
    }

    fn lock() -> MutexGuard<'static, Cache> {
        CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The last blocks highlighted, the most recent last, and how fast each
    /// syntax parses.
    struct Cache {
        entries: Vec<Entry>,
        /// Nanoseconds per byte, as last measured.
        rates: Vec<(&'static str, f64)>,
    }

    struct Entry {
        syntax: &'static str,
        code: String,
        tokens: Tokens,
        /// Where the last line starts, and the parser there: a block that
        /// grew past it is parsed on from it.
        resume: Option<(usize, ParseState, ScopeStack)>,
    }

    impl Cache {
        fn get(&mut self, syntax: &SyntaxReference, code: &str) -> Option<Tokens> {
            let i = self
                .entries
                .iter()
                .rposition(|e| e.syntax == syntax.name && e.code == code)?;
            let entry = self.entries.remove(i);
            let tokens = entry.tokens.clone();
            self.entries.push(entry);
            Some(tokens)
        }

        fn rate(&self, syntax: &SyntaxReference) -> Option<f64> {
            self.rates
                .iter()
                .find(|(name, _)| *name == syntax.name)
                .map(|(_, rate)| *rate)
        }

        /// The parsing of `code`: on from the entry whose code up to its
        /// last line starts it (the longest, if several do), else from its
        /// start.
        fn job(&self, syntax: &'static SyntaxReference, code: &str) -> Job {
            let grown = self
                .entries
                .iter()
                .filter(|e| e.syntax == syntax.name)
                .filter_map(|e| {
                    let (at, state, scopes) = e.resume.as_ref()?;
                    code.starts_with(&e.code[..*at])
                        .then_some((e, *at, state, scopes))
                })
                .max_by_key(|(_, at, ..)| *at);
            match grown {
                Some((entry, at, state, scopes)) => {
                    let mut tokens: Tokens = entry
                        .tokens
                        .iter()
                        .filter(|(range, _)| range.start < at)
                        .cloned()
                        .collect();
                    if let Some((last, _)) = tokens.last_mut() {
                        last.end = last.end.min(at);
                    }
                    Job {
                        syntax,
                        code: code.to_owned(),
                        from: at,
                        state: state.clone(),
                        scopes: scopes.clone(),
                        tokens,
                        resume: None,
                        took: 0.0,
                    }
                }
                None => Job {
                    syntax,
                    code: code.to_owned(),
                    from: 0,
                    state: ParseState::new(syntax),
                    scopes: ScopeStack::new(),
                    tokens: Tokens::new(),
                    resume: None,
                    took: 0.0,
                },
            }
        }

        /// Keeps a finished job's tokens, in place of the entries it grew
        /// from, and how fast it parsed.
        fn finish(&mut self, job: Job) {
            let name = job.syntax.name.as_str();
            let parsed = job.code.len() - job.from;
            // A few bytes say more about the call than about the syntax.
            if parsed >= 256 {
                let rate = job.took / parsed as f64;
                match self.rates.iter_mut().find(|(n, _)| *n == name) {
                    Some((_, r)) => *r = rate,
                    None => self.rates.push((name, rate)),
                }
            }
            self.entries
                .retain(|e| !(e.syntax == name && job.code.starts_with(&e.code)));
            if self.entries.len() >= CACHE_SIZE {
                self.entries.remove(0);
            }
            self.entries.push(Entry {
                syntax: name,
                code: job.code,
                tokens: job.tokens,
                resume: job.resume,
            });
        }
    }

    /// Parsing `code` from byte `from` (a line's start) with the parser's
    /// state there, adding to `tokens`.
    struct Job {
        syntax: &'static SyntaxReference,
        code: String,
        from: usize,
        state: ParseState,
        scopes: ScopeStack,
        tokens: Tokens,
        resume: Option<(usize, ParseState, ScopeStack)>,
        /// Nanoseconds it took.
        took: f64,
    }

    impl Job {
        fn run(&mut self) {
            let start = Instant::now();
            let set = syntaxes();
            let mut offset = self.from;
            let mut lines = LinesWithEndings::from(&self.code[self.from..]).peekable();
            while let Some(line) = lines.next() {
                if lines.peek().is_none() {
                    self.resume = Some((offset, self.state.clone(), self.scopes.clone()));
                }
                // A line syntect cannot parse keeps the scopes it started
                // with; the next line starts over from them.
                if let Ok(operations) = self.state.parse_line(line, set) {
                    let mut cursor = 0;
                    for (index, operation) in operations {
                        let range = offset + cursor..offset + index;
                        push(&mut self.tokens, range, &self.code, &self.scopes);
                        let _ = self.scopes.apply(&operation);
                        cursor = index;
                    }
                    let range = offset + cursor..offset + line.len();
                    push(&mut self.tokens, range, &self.code, &self.scopes);
                }
                offset += line.len();
            }
            self.took = start.elapsed().as_nanos() as f64;
        }
    }

    /// Adds `range` with the token of its innermost scope that has one.
    fn push(tokens: &mut Tokens, range: Range<usize>, code: &str, scopes: &ScopeStack) {
        if range.is_empty() {
            return;
        }
        let Some(token) = scope_token(scopes, &code[range.clone()]) else {
            return;
        };
        match tokens.last_mut() {
            Some((last, last_token)) if last.end == range.start && *last_token == token => {
                last.end = range.end;
            }
            _ => tokens.push((range, token)),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn check(language: &str, code: &str) -> Tokens {
            let tokens = tokens(language, code);
            assert!(!tokens.is_empty(), "{language}: no tokens");
            let mut at = 0;
            for (range, _) in &tokens {
                assert!(range.start >= at, "{language}: out of order or overlapping");
                assert!(range.start < range.end, "{language}: empty range");
                assert!(code.is_char_boundary(range.start) && code.is_char_boundary(range.end));
                assert!(range.end <= code.len());
                at = range.end;
            }
            tokens
        }

        fn token_of(tokens: &Tokens, code: &str, word: &str) -> Option<Token> {
            let start = code.find(word).unwrap();
            tokens
                .iter()
                .find(|(range, _)| range.start <= start && start + word.len() <= range.end)
                .map(|(_, token)| *token)
        }

        #[test]
        fn typescript_and_rust_keywords_are_colored() {
            let ts = "// 注释 ✓\nexport async function load(id: number): Promise<string> {\n  const s = \"héllo\";\n  return s;\n}";
            let tokens = check("ts", ts);
            assert_eq!(token_of(&tokens, ts, "function"), Some(Token::Keyword));
            assert_eq!(token_of(&tokens, ts, "load"), Some(Token::Title));
            assert_eq!(token_of(&tokens, ts, "\"héllo\""), Some(Token::String));
            assert_eq!(token_of(&tokens, ts, "// 注释"), Some(Token::Comment));
            assert_eq!(check("TSX", ts), tokens, "case-insensitive");

            let rs = "fn main() {\n    let x: u32 = 42; // ünïcode\n}\n";
            let tokens = check("rust", rs);
            assert_eq!(token_of(&tokens, rs, "fn"), Some(Token::Keyword));
            assert_eq!(token_of(&tokens, rs, "main"), Some(Token::Title));
            assert_eq!(token_of(&tokens, rs, "u32"), Some(Token::Built));
            assert_eq!(token_of(&tokens, rs, "42"), Some(Token::Number));
            assert_eq!(check("rs", rs), tokens);
        }

        #[test]
        fn aliases_find_syntaxes() {
            for language in [
                "ts",
                "tsx",
                "typescript",
                "js",
                "jsx",
                "sh",
                "bash",
                "shell",
                "zsh",
                "py",
                "python",
                "rs",
                "json",
                "toml",
                "yaml",
                "yml",
                "md",
                "diff",
                "Rust",
            ] {
                assert!(find_syntax(language).is_some(), "{language}");
            }
        }

        #[test]
        fn unknown_languages_are_plain() {
            assert!(tokens("no-such-language", "let x = 1").is_empty());
            assert!(tokens("", "let x = 1").is_empty());
            assert!(tokens("text", "let x = 1").is_empty());
        }

        #[test]
        fn a_growing_block_is_highlighted_as_a_whole_one() {
            let code = "fn main() {\n    let s = \"a\nb\";\n    /* c\n d */ let y = 2;\n}\n";
            let syntax = find_syntax("rust").unwrap();
            for end in (0..=code.len()).filter(|&i| code.is_char_boundary(i)) {
                // As it streams: on from what the cache holds.
                let grown = tokens("rust", &code[..end]);
                // Fresh, without the cache.
                let mut job = Cache {
                    entries: Vec::new(),
                    rates: Vec::new(),
                }
                .job(syntax, &code[..end]);
                job.run();
                assert_eq!(grown, job.tokens, "at {end}");
            }
        }

        #[test]
        fn rust_declarations_and_types_share_a_scope() {
            let rs = "let a: f32 = 1.0 as f32; const B: u8 = 2;";
            let tokens = check("rust", rs);
            assert_eq!(token_of(&tokens, rs, "let"), Some(Token::Keyword));
            assert_eq!(token_of(&tokens, rs, "const"), Some(Token::Keyword));
            assert_eq!(token_of(&tokens, rs, "f32"), Some(Token::Built));
            assert_eq!(token_of(&tokens, rs, "as"), Some(Token::Keyword));
            assert_eq!(token_of(&tokens, rs, "="), None);
            assert!(spans(rs, &tokens).len() >= tokens.len());
        }

        /// `cargo test --release -p nsh-base bench_highlight -- --ignored --nocapture`
        #[test]
        #[ignore]
        fn bench_highlight() {
            let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../");
            for (language, path) in [
                ("tsx", "examples/gallery/demos/Chat.tsx"),
                ("rust", "crates/nsh-base/src/text_view/view.rs"),
                ("python", ".github/ci/paths.py"),
            ] {
                let source = std::fs::read_to_string(format!("{root}{path}")).unwrap();
                let code: String = source.split_inclusive('\n').take(500).collect();
                let lines = code.lines().count();
                let time = |code: &str| {
                    let start = std::time::Instant::now();
                    let tokens = tokens(language, code);
                    (start.elapsed(), tokens.len())
                };
                let (first, count) = time(&code);
                let (cached, _) = time(&code);
                let (grown, _) = time(&format!("{code}let x = 1;"));
                // The regexes are compiled as the parser first meets them.
                let (again, _) = time(&format!("// changed\n{code}"));
                // What the engine thread pays for a block it leaves to a
                // blocking thread.
                let fresh = format!("// fresh\n{code}");
                let start = std::time::Instant::now();
                let deferred = now(find_syntax(language).unwrap(), &fresh).is_err();
                let engine = start.elapsed();
                println!(
                    "{language}, {lines} lines: first {first:?} ({count} tokens), again \
                     {again:?}, cached {cached:?}, grown by a line {grown:?}, fresh on the \
                     engine thread {engine:?} (deferred: {deferred})"
                );
            }
        }
    }
}
