//! Markdown as you type, paste and copy: block shortcuts (`# `, `> `,
//! `- `, `1. `, ```` ``` ````, `---`) and inline marks (`**bold**`,
//! `*italic*`, `` `code` ``, `~~strike~~`, `[text](url)`) turn into the
//! schema's nodes and marks as their syntax completes; pasted plain text
//! that looks like Markdown is read as Markdown; copies put Markdown on
//! the clipboard. Every rule maps through [`MarkdownNames`], so custom
//! schemas work, and a rule whose type the schema lacks never fires.
//!
//! Each rule is one transaction (the typed character included), so one
//! undo restores what was typed before the rule ran.

use std::sync::{Arc, OnceLock};

use regex::Regex;
use serde_json::Value;

use crate::rich_editor::{
    commands::list::wrap_range_in_list,
    extensions::input_rules::{InputRulesState, mark_rule, record_rule},
    formats::{MarkdownFormat, MarkdownNames},
    model::{Attrs, Fragment, Node, ResolvedPos, Slice},
    state::{
        EditorState, EditorStateConfig, Plugin, PluginKey, PluginSpec, PluginState, TextSelection,
        Transaction, TransactionOrigin,
    },
    transform::find_wrapping,
};

/// What the Markdown extension does; every group is on by default.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct MarkdownOptions {
    /// The schema's names for Markdown's constructs.
    pub names: MarkdownNames,
    /// Block shortcuts typed at a textblock's start: headings, quotes,
    /// lists, code fences, rules.
    pub block_rules: bool,
    /// Inline marks completed by their closing delimiter.
    pub inline_rules: bool,
    /// Pasted plain text that looks like Markdown is read as Markdown.
    pub paste: bool,
    /// Copies put Markdown on the clipboard as their plain text.
    pub copy_as_markdown: bool,
}

impl Default for MarkdownOptions {
    fn default() -> Self {
        Self {
            names: MarkdownNames::default(),
            block_rules: true,
            inline_rules: true,
            paste: true,
            copy_as_markdown: true,
        }
    }
}

/// The Markdown extension's plugins (one plugin, key `markdown`).
pub fn markdown(options: MarkdownOptions) -> Vec<Plugin> {
    vec![Arc::new(MarkdownPlugin::new(options))]
}

/// The plugin [`markdown`] makes; public so frameworks can call its rules
/// and clipboard conversions directly.
#[derive(Debug, Clone)]
pub struct MarkdownPlugin {
    options: MarkdownOptions,
    format: MarkdownFormat,
}

/// How much text before the cursor rules look at, as ProseMirror's input
/// rules do: enough for any shortcut, bounded on long paragraphs.
const MAX_MATCH: usize = 500;

/// The placeholder inline leaves count as in the text rules match: one
/// UTF-16 unit, as a leaf counts one position.
const LEAF: char = '\u{fffc}';

impl MarkdownPlugin {
    /// A plugin with `options`.
    pub fn new(options: MarkdownOptions) -> Self {
        let format = MarkdownFormat::new(options.names.clone());
        Self { options, format }
    }

    /// The transaction `text` typed over `from..to` makes when it completes
    /// a rule, or `None` when no rule applies.
    pub fn rule_transaction(
        &self,
        state: &EditorState,
        from: usize,
        to: usize,
        text: &str,
    ) -> Option<Transaction> {
        let rp = state.doc().resolve(from).ok()?;
        let parent = rp.parent();
        if !parent.is_textblock() || parent.ty().spec().code {
            return None;
        }
        // Rules never fire across a selection spanning blocks.
        if to > rp.end(rp.depth) {
            return None;
        }
        let start = rp.start(rp.depth);
        let full = inline_text(parent);
        let before_len = from - start;
        let before = &full[..utf16_to_byte(&full, before_len)];
        // Bound the text matched, starting on a char boundary.
        let cut = utf16_to_byte(before, before_len.saturating_sub(MAX_MATCH));
        let base = start + utf16_len(&before[..cut]);
        let text_before = format!("{}{text}", &before[cut..]);
        if self.options.block_rules
            && cut == 0
            && let Some(tr) = self.block_rule(state, &rp, &text_before, to)
        {
            return Some(tr);
        }
        if self.options.inline_rules {
            return self.inline_rule(state, base, &text_before, from, to, text);
        }
        None
    }

    fn block_rule(
        &self,
        state: &EditorState,
        rp: &ResolvedPos,
        text: &str,
        to: usize,
    ) -> Option<Transaction> {
        let n = &self.options.names;
        let schema = state.schema();
        let start = rp.start(rp.depth);
        let mut tr = state.tr();
        if let Some(c) = re(&HEADING, r"^(#{1,6})\s$").captures(text) {
            let ty = schema.node_type(&n.heading)?;
            let mut attrs = Attrs::new();
            attrs.insert(n.heading_level.clone(), Value::from(c[1].len()));
            tr.delete(start, to).ok()?;
            tr.set_block_type(start, start, &ty, Some(attrs)).ok()?;
        } else if let Some(c) = re(&FENCE, r"^```([\w+#.-]*)\s$").captures(text) {
            let ty = schema.node_type(&n.code_block)?;
            let mut attrs = Attrs::new();
            if !c[1].is_empty() {
                attrs.insert(n.code_language.clone(), Value::from(&c[1]));
            }
            tr.delete(start, to).ok()?;
            tr.set_block_type(start, start, &ty, Some(attrs)).ok()?;
        } else if re(&QUOTE, r"^>\s$").is_match(text) {
            let ty = schema.node_type(&n.blockquote)?;
            tr.delete(start, to).ok()?;
            let at = tr.doc().resolve(start).ok()?;
            let range = at.block_range(&at, None)?;
            let wrapping = find_wrapping(&range, &ty, None, None)?;
            tr.wrap(&range, &wrapping).ok()?;
        } else if let Some(c) = re(&ORDERED, r"^(\d+)\.\s$").captures(text) {
            let ty = schema.node_type(&n.ordered_list)?;
            schema.node_type(&n.list_item)?;
            let mut attrs = Attrs::new();
            attrs.insert(n.list_start.clone(), Value::from(c[1].parse::<u64>().ok()?));
            tr.delete(start, to).ok()?;
            let at = tr.doc().resolve(start).ok()?;
            let range = at.block_range(&at, None)?;
            if !wrap_range_in_list(Some(&mut tr), &range, &ty, Some(attrs)) {
                return None;
            }
        } else if re(&BULLET, r"^[-+*]\s$").is_match(text) {
            let ty = schema.node_type(&n.bullet_list)?;
            schema.node_type(&n.list_item)?;
            tr.delete(start, to).ok()?;
            let at = tr.doc().resolve(start).ok()?;
            let range = at.block_range(&at, None)?;
            if !wrap_range_in_list(Some(&mut tr), &range, &ty, None) {
                return None;
            }
        } else if re(&RULE, r"^(?:---|\*\*\*|___)$").is_match(text) {
            schema.node_type(&n.horizontal_rule)?;
            // Only a block holding nothing but the rule's characters.
            if to != rp.end(rp.depth) {
                return None;
            }
            let hr = schema
                .node(&n.horizontal_rule, None, Fragment::empty(), Vec::new())
                .ok()?;
            let para = schema
                .node(rp.parent().ty().name(), None, Fragment::empty(), Vec::new())
                .ok()?;
            let (before, after) = (rp.before(rp.depth), rp.after(rp.depth));
            let hr_size = hr.node_size();
            tr.replace_with(before, after, Fragment::from(vec![hr, para]))
                .ok()?;
            let selection = TextSelection::create(tr.doc(), before + hr_size + 1, None);
            tr.set_selection(selection);
        } else {
            return None;
        }
        tr.set_origin(TransactionOrigin::Input);
        Some(tr)
    }

    fn inline_rule(
        &self,
        state: &EditorState,
        base: usize,
        text: &str,
        from: usize,
        to: usize,
        typed: &str,
    ) -> Option<Transaction> {
        let n = &self.options.names;
        // (mark name, attrs, match start, content start, content end) in
        // `text`'s bytes.
        let found = if let Some(c) =
            re(&LINK, r#"\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$"#).captures(text)
        {
            let mut attrs = Attrs::new();
            attrs.insert("href".into(), Value::from(&c[2]));
            attrs.insert(
                "title".into(),
                c.get(3).map_or(Value::Null, |t| Value::from(t.as_str())),
            );
            let all = c.get(0)?;
            let inner = c.get(1)?;
            Some((&n.link, attrs, all.start(), inner.start(), inner.end()))
        } else {
            let delimited: [(&OnceLock<Regex>, &str, &String); 6] = [
                (
                    &BOLD_STARS,
                    r"(?:^|[^*])(\*\*([^*\s](?:[^*]*[^*\s])?)\*\*)$",
                    &n.strong,
                ),
                (
                    &BOLD_UNDERSCORES,
                    r"(?:^|[^_\w])(__([^_\s](?:[^_]*[^_\s])?)__)$",
                    &n.strong,
                ),
                (
                    &ITALIC_STAR,
                    r"(?:^|[^*])(\*([^*\s](?:[^*]*[^*\s])?)\*)$",
                    &n.emphasis,
                ),
                (
                    &ITALIC_UNDERSCORE,
                    r"(?:^|[^_\w])(_([^_\s](?:[^_]*[^_\s])?)_)$",
                    &n.emphasis,
                ),
                (&CODE, r"(?:^|[^`])(`([^`]+)`)$", &n.code),
                (
                    &STRIKE,
                    r"(?:^|[^~])(~~([^~\s](?:[^~]*[^~\s])?)~~)$",
                    &n.strike,
                ),
            ];
            delimited.into_iter().find_map(|(cell, pattern, name)| {
                let c = re(cell, pattern).captures(text)?;
                let (all, inner) = (c.get(1)?, c.get(2)?);
                Some((name, Attrs::new(), all.start(), inner.start(), inner.end()))
            })
        };
        let (name, attrs, m_start, c_start, c_end) = found?;
        let schema = state.schema();
        let mark_ty = schema.mark_type(name)?;
        let rp = state.doc().resolve(from).ok()?;
        if !rp.parent().ty().allows_mark_type(&mark_ty) || text[c_start..c_end].contains(LEAF) {
            return None;
        }
        let mark = schema.mark(name, Some(attrs)).ok()?;
        let pos = |byte: usize| base + utf16_len(&text[..byte]);
        let (m_start, c_start, c_end, m_end) =
            (pos(m_start), pos(c_start), pos(c_end), pos(text.len()));
        let mut tr = state.tr();
        // Type the character first, so the text the positions count is in
        // the document; then drop the closing delimiter before the opening
        // one, which keeps the earlier positions valid.
        tr.insert_text(typed, Some(from), Some(to));
        tr.delete(c_end, m_end).ok()?;
        tr.delete(m_start, c_start).ok()?;
        let len = c_end - c_start;
        tr.add_mark(m_start, m_start + len, mark.clone()).ok()?;
        // What is typed next continues outside the mark.
        tr.remove_stored_mark(&mark);
        tr.set_origin(TransactionOrigin::Input);
        Some(tr)
    }

    /// The slice pasted plain `text` becomes when it looks like Markdown.
    pub fn parse_pasted_text(&self, state: &EditorState, text: &str) -> Option<Slice> {
        if !looks_like_markdown(text) {
            return None;
        }
        let fragment = self.format.parse_fragment(state.schema(), text).ok()?;
        let open = |node: Option<&Node>| usize::from(node.is_some_and(|n| n.is_textblock()));
        let (open_start, open_end) = (open(fragment.first_child()), open(fragment.last_child()));
        Some(Slice::new(fragment, open_start, open_end))
    }

    /// `slice` as Markdown.
    pub fn serialize_slice(&self, slice: &Slice) -> String {
        self.format.serialize_fragment(&slice.content)
    }
}

impl PluginSpec for MarkdownPlugin {
    fn key(&self) -> PluginKey {
        PluginKey::new("markdown")
    }

    fn init_state(&self, _: &EditorStateConfig, _: &EditorState) -> Option<PluginState> {
        Some(Arc::new(InputRulesState::default()))
    }

    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        _: &EditorState,
        _: &EditorState,
    ) -> PluginState {
        record_rule("markdown", tr, value)
    }

    fn handle_text_input(
        &self,
        state: &EditorState,
        from: usize,
        to: usize,
        text: &str,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        match self.rule_transaction(state, from, to, text) {
            Some(mut tr) => {
                // Backspace right after takes the rule back
                // (`undo_input_rule`), as input rules' rules.
                mark_rule(&mut tr, "markdown", from, to, text);
                dispatch(tr);
                true
            }
            None => false,
        }
    }

    fn clipboard_text_parser(
        &self,
        state: &EditorState,
        text: &str,
        context: &ResolvedPos,
        plain: bool,
    ) -> Option<Slice> {
        // A plain paste (Shift) and pastes into code keep the text as is.
        if !self.options.paste || plain || context.parent().ty().spec().code {
            return None;
        }
        self.parse_pasted_text(state, text)
    }

    fn clipboard_text_serializer(&self, _state: &EditorState, slice: &Slice) -> Option<String> {
        self.options
            .copy_as_markdown
            .then(|| self.serialize_slice(slice))
    }
}

static HEADING: OnceLock<Regex> = OnceLock::new();
static FENCE: OnceLock<Regex> = OnceLock::new();
static QUOTE: OnceLock<Regex> = OnceLock::new();
static ORDERED: OnceLock<Regex> = OnceLock::new();
static BULLET: OnceLock<Regex> = OnceLock::new();
static RULE: OnceLock<Regex> = OnceLock::new();
static LINK: OnceLock<Regex> = OnceLock::new();
static BOLD_STARS: OnceLock<Regex> = OnceLock::new();
static BOLD_UNDERSCORES: OnceLock<Regex> = OnceLock::new();
static ITALIC_STAR: OnceLock<Regex> = OnceLock::new();
static ITALIC_UNDERSCORE: OnceLock<Regex> = OnceLock::new();
static CODE: OnceLock<Regex> = OnceLock::new();
static STRIKE: OnceLock<Regex> = OnceLock::new();
static LOOKS_LIKE: OnceLock<Regex> = OnceLock::new();

fn re<'a>(cell: &'a OnceLock<Regex>, pattern: &str) -> &'a Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a valid pattern"))
}

/// Whether pasted text has Markdown syntax: block markers at a line's
/// start, fences, a table's delimiter row (`|---|---|`), or complete inline marks and links. Plain prose (even
/// with a lone `*` or `#`) does not.
pub fn looks_like_markdown(text: &str) -> bool {
    re(
        &LOOKS_LIKE,
        r"(?m)^(?:#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|```|---\s*$|\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|(?:^|\s)[*_][^*_\s][^*_\n]*[*_](?:\s|$)",
    )
    .is_match(text)
}

/// A textblock's inline content as text, inline leaves as [`LEAF`], so
/// UTF-16 offsets in it are offsets from the block's start.
fn inline_text(block: &Node) -> String {
    let mut out = String::new();
    for i in 0..block.child_count() {
        let child = block.child(i);
        match child.text() {
            Some(text) => out.push_str(text),
            None => out.push(LEAF),
        }
    }
    out
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn utf16_to_byte(text: &str, units: usize) -> usize {
    let mut seen = 0;
    for (i, c) in text.char_indices() {
        if seen >= units {
            return i;
        }
        seen += c.len_utf16();
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::{
        extensions::starter,
        formats::DocFormat,
        model::Schema,
        state::{EditorStateConfig, Selection},
    };

    fn plugin() -> MarkdownPlugin {
        MarkdownPlugin::new(MarkdownOptions::default())
    }

    /// A state of `md` (Markdown) with the cursor at the end of the last
    /// textblock.
    fn state(schema: &Schema, md: &str) -> EditorState {
        let doc = MarkdownFormat::default().parse(schema, md).unwrap();
        let selection = Selection::at_end(&doc);
        EditorState::create(
            EditorStateConfig::new(schema.clone())
                .doc(doc)
                .selection(selection),
        )
        .unwrap()
    }

    /// Types `text` character by character as the view would: the plugin
    /// first, plain insertion otherwise.
    fn type_text(plugin: &MarkdownPlugin, mut state: EditorState, text: &str) -> EditorState {
        for c in text.chars() {
            let s = c.to_string();
            let (from, to) = (state.selection().from(), state.selection().to());
            let mut sent = None;
            if !plugin.handle_text_input(&state, from, to, &s, &mut |tr| sent = Some(tr)) {
                let mut tr = state.tr();
                tr.insert_text(&s, None, None);
                sent = Some(tr);
            }
            state = state.apply(sent.unwrap()).unwrap();
        }
        state
    }

    fn md(state: &EditorState) -> String {
        MarkdownFormat::default().serialize(state.doc()).unwrap()
    }

    fn typed(input: &str) -> EditorState {
        let schema = starter::schema();
        type_text(&plugin(), state(&schema, ""), input)
    }

    #[test]
    fn headings() {
        for level in 1..=6 {
            let s = typed(&format!("{} Title", "#".repeat(level)));
            assert_eq!(s.doc().child(0).ty().name(), "heading");
            assert_eq!(
                s.doc().child(0).attrs().get("level"),
                Some(&Value::from(level))
            );
            assert_eq!(s.doc().child(0).text_content(), "Title");
        }
        assert_eq!(typed("####### x").doc().child(0).ty().name(), "paragraph");
    }

    #[test]
    fn blockquote() {
        let s = typed("> quoted");
        assert_eq!(s.doc().child(0).ty().name(), "blockquote");
        assert_eq!(md(&s), "> quoted\n");
    }

    #[test]
    fn bullet_lists() {
        for marker in ["-", "*", "+"] {
            let s = typed(&format!("{marker} item"));
            assert_eq!(s.doc().child(0).ty().name(), "bulletList", "{marker}");
            assert_eq!(md(&s), "- item\n");
        }
    }

    #[test]
    fn ordered_list_keeps_its_start() {
        let s = typed("3. third");
        assert_eq!(s.doc().child(0).ty().name(), "orderedList");
        assert_eq!(s.doc().child(0).attrs().get("start"), Some(&Value::from(3)));
    }

    #[test]
    fn code_fence_with_language() {
        let s = typed("```rust fn");
        let block = s.doc().child(0);
        assert_eq!(block.ty().name(), "codeBlock");
        assert_eq!(block.attrs().get("language"), Some(&Value::from("rust")));
        assert_eq!(block.text_content(), "fn");
        // Rules do not fire inside code.
        let s = type_text(&plugin(), s, " **x**");
        assert_eq!(s.doc().child(0).text_content(), "fn **x**");
    }

    #[test]
    fn horizontal_rules() {
        for rule in ["---", "***", "___"] {
            let s = typed(rule);
            assert_eq!(s.doc().child(0).ty().name(), "horizontalRule", "{rule}");
            assert_eq!(s.doc().child(1).ty().name(), "paragraph");
        }
    }

    #[test]
    fn block_rules_only_at_a_blocks_start() {
        assert_eq!(md(&typed("a # b")), "a # b\n");
    }

    #[test]
    fn inline_marks() {
        for (input, mark, text) in [
            ("**bold**", "bold", "bold"),
            ("__bold__", "bold", "bold"),
            ("*it*", "italic", "it"),
            ("_it_", "italic", "it"),
            ("`co de`", "code", "co de"),
            ("~~gone~~", "strike", "gone"),
        ] {
            let s = typed(&format!("a {input} z"));
            let para = s.doc().child(0);
            assert_eq!(para.text_content(), format!("a {text} z"), "{input}");
            assert!(
                para.child(1).marks().iter().any(|m| m.ty.name() == mark),
                "{input}"
            );
            // Typing after the closing delimiter continues unmarked.
            assert!(para.child(2).marks().is_empty(), "{input}");
        }
    }

    #[test]
    fn links() {
        let s = typed("see [docs](https://x.y \"T\") now");
        let para = s.doc().child(0);
        assert_eq!(para.text_content(), "see docs now");
        let link = &para.child(1).marks()[0];
        assert_eq!(link.ty.name(), "link");
        assert_eq!(link.attrs.get("href"), Some(&Value::from("https://x.y")));
        assert_eq!(link.attrs.get("title"), Some(&Value::from("T")));
    }

    #[test]
    fn inline_rules_need_content() {
        assert_eq!(typed("a ** b").doc().child(0).text_content(), "a ** b");
        assert_eq!(
            typed("snake_case_name").doc().child(0).text_content(),
            "snake_case_name"
        );
    }

    #[test]
    fn disabled_groups_do_nothing() {
        let schema = starter::schema();
        let off = MarkdownPlugin::new(MarkdownOptions {
            block_rules: false,
            inline_rules: false,
            ..MarkdownOptions::default()
        });
        let s = type_text(&off, state(&schema, ""), "# **x**");
        assert_eq!(s.doc().child(0).ty().name(), "paragraph");
        assert_eq!(s.doc().child(0).text_content(), "# **x**");
    }

    #[test]
    fn missing_types_skip_their_rules() {
        let schema = starter::schema();
        let names = MarkdownNames {
            heading: "no_such_heading".into(),
            strong: "no_such_mark".into(),
            ..MarkdownNames::default()
        };
        let p = MarkdownPlugin::new(MarkdownOptions {
            names,
            ..MarkdownOptions::default()
        });
        let s = type_text(&p, state(&schema, ""), "# **x**");
        assert_eq!(s.doc().child(0).ty().name(), "paragraph");
        assert_eq!(s.doc().child(0).text_content(), "# **x**");
    }

    #[test]
    fn one_rule_is_one_transaction() {
        let schema = starter::schema();
        let s = state(&schema, "a **b*");
        let (from, to) = (s.selection().from(), s.selection().to());
        let mut count = 0;
        assert!(plugin().handle_text_input(&s, from, to, "*", &mut |_| count += 1));
        assert_eq!(count, 1);
    }

    #[test]
    fn paste_reads_markdown() {
        let schema = starter::schema();
        let s = state(&schema, "x");
        let at = s.selection().resolved_from().clone();
        let p = plugin();
        let slice = p
            .clipboard_text_parser(&s, "# Title\n\n- **a**\n- b", &at, false)
            .unwrap();
        assert_eq!(slice.content.child(0).ty().name(), "heading");
        assert_eq!(slice.content.child(1).ty().name(), "bulletList");
        assert_eq!((slice.open_start, slice.open_end), (1, 0));
        // Prose, a plain paste and a disabled option keep the text.
        assert!(
            p.clipboard_text_parser(&s, "just words, 2 * 3", &at, false)
                .is_none()
        );
        assert!(p.clipboard_text_parser(&s, "# Title", &at, true).is_none());
        let off = MarkdownPlugin::new(MarkdownOptions {
            paste: false,
            ..MarkdownOptions::default()
        });
        assert!(
            off.clipboard_text_parser(&s, "# Title", &at, false)
                .is_none()
        );
    }

    #[test]
    fn copy_writes_markdown() {
        let schema = starter::schema();
        let s = state(&schema, "## Head\n\nsome **bold** text");
        let slice = Slice::new(s.doc().content().clone(), 0, 0);
        let p = plugin();
        assert_eq!(
            p.clipboard_text_serializer(&s, &slice).unwrap(),
            "## Head\n\nsome **bold** text"
        );
        // Inline content copies as one line.
        let inline = Slice::new(s.doc().child(1).content().clone(), 0, 0);
        assert_eq!(
            p.clipboard_text_serializer(&s, &inline).unwrap(),
            "some **bold** text"
        );
        let off = MarkdownPlugin::new(MarkdownOptions {
            copy_as_markdown: false,
            ..MarkdownOptions::default()
        });
        assert!(off.clipboard_text_serializer(&s, &slice).is_none());
    }

    #[test]
    fn markdown_detection() {
        for yes in [
            "# H",
            "- a",
            "1. a",
            "> q",
            "```",
            "**b**",
            "`c`",
            "[a](b)",
            "~~s~~",
            "an *em* word",
        ] {
            assert!(looks_like_markdown(yes), "{yes}");
        }
        for no in ["plain words", "2 * 3 = 6", "#hashtag", "a_b_c"] {
            assert!(!looks_like_markdown(no), "{no}");
        }
    }
}
