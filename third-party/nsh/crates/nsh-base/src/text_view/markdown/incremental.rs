//! Markdown that grows at its end (a reply streamed by an AI model), read
//! without reading again the blocks that can no longer change.
//!
//! [`Incremental`] is the state of one `TextView`: the text it read last,
//! an offset in it (the boundary) and the blocks before it. When the next
//! text starts with the last one and the parser is the same, only the text
//! from the boundary on (the tail) is repaired, rewritten, parsed and
//! converted; the blocks before it are the ones made earlier, shared
//! ([`SharedBlock`]), so what compares them compares pointers. The result
//! is the document [`super::parse_whole`] makes of the whole text, which
//! stays the reference: the tests read every prefix of their documents both
//! ways.
//!
//! The boundary moves to the start of a line when all of these hold:
//!
//! - the line before it is blank, and the scans that read lines with a
//!   state of their own are there in the state they start a text in: the
//!   streaming repair's (outside fenced code and `$$`), the TeX rewrite's
//!   (outside fenced code). Both tell where (`repair_tail`,
//!   `rewrite_blanks`), so the tail is repaired and rewritten as the end of
//!   the whole text is;
//! - the line has ended and shows text, and the repair changed nothing up
//!   to its end: what a line means is settled once it ends, not while its
//!   characters arrive (`#` is a heading, `#a` goes on with the paragraph
//!   above);
//! - in the tail's syntax tree a block of the top level starts on that line
//!   and every block before it ends before it. A blank line inside a list,
//!   a quote, fenced code, a formula, an HTML block or indented code is no
//!   boundary: the block around it is still open;
//! - the block before it is a paragraph. `markdown-rs` carries state from
//!   line to line that a blank line does not always clear, and a block
//!   read after it is then not read as the first block of a text is: a
//!   list item, and a quote whose paragraph went on without its `>`, are
//!   closed only by the first line that does not go on with them, which is
//!   then read as a line that might have (`lazy`: it starts no table and
//!   underlines no heading, an HTML block ends at another line, what may
//!   interrupt its paragraph differs); a row of cells cut short by a quote
//!   (`| a |` then `>`) leaves the quote open across the code, headings and
//!   rules after it. A paragraph of the top level is where this ends: its
//!   first line closes what is open, the blank line after it ends it;
//! - no HTML element is open across it: an opening tag on lines of its own
//!   (`<details>`) takes the blocks up to its closing tag as its content
//!   when that arrives, so nothing after a tag waiting for one is final.
//!
//! What a later line can change in every block is not read this way at all,
//! and the whole text is parsed as before:
//!
//! - a link or footnote definition anywhere: references before it resolve,
//!   footnotes are numbered by their first reference. The text is still
//!   parsed once: a tree read from the text's start is the whole text's and
//!   is converted as it is; a definition first seen in a tail drops what
//!   was kept, so the reads after it start there. A tail with a line that
//!   looks like a definition (`may_define`) is not read at all: the text
//!   is read from its start at once. That is a guess to save the tail's
//!   tree, narrow because `]:` is all over code (`if seen[key]:`); the
//!   tree alone says whether there is a definition;
//! - plugins that turn a construct on or off (`MarkdownPlugin::configure`),
//!   declared `:::` containers (cut out of the whole source before
//!   parsing) and MDX;
//! - front matter still open (`---` first, its closing line not arrived);
//! - a line held back by the repair at the start of the tail (the repair
//!   then reaches the block before the boundary);
//! - a text that does not start with the last one, or another parser.
//!
//! A heading's anchor depends on the headings before it, so the state keeps
//! the [`Slugger`] as of the boundary; the tail's headings are forgotten
//! again after each read (`Slugger::rewind`).
//!
//! A long text given at once (a file opened, a reply shown whole) is read
//! the same way, a part at a time (`parse_long`): one parse of a whole text
//! costs more than its length does, a read from the boundary on what its
//! tail's does. A text the boundary cannot cross is read about as one parse
//! reads it, and one that may define a link or a footnote is read whole.
//!
//! Plugins are shown what one parse shows them: the whole text as parsed
//! (`ParseContext::source`) and positions in it, in the order one parse
//! offers the nodes. What a plugin made of a text may depend on any of it,
//! so no block is kept for the next text: a text read with plugins is read
//! from its start every time, in parts when it is long.

use std::{borrow::Cow, ops::Deref, rc::Rc};

use markdown::mdast::Node;
use nsh_core::element::SharedString;

use super::{
    Converter, Tree, latex, matching_close, parse_whole,
    streaming::{blank_lines, repair_tail},
    tree, unclosed_element,
};
use crate::text_view::{
    Parser,
    common::Slugger,
    document::{Block, Document, Footnote},
};

/// A block of a document, shared by the documents it is in. Two of the same
/// allocation are equal without their content being compared, which is what
/// keeps the comparisons of a growing document from growing with it.
#[derive(Debug, Clone)]
pub(crate) struct SharedBlock(Rc<Block>);

impl SharedBlock {
    fn new(block: Block) -> Self {
        Self(Rc::new(block))
    }
}

impl Deref for SharedBlock {
    type Target = Block;

    fn deref(&self) -> &Block {
        &self.0
    }
}

impl PartialEq for SharedBlock {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0) || self.0 == other.0
    }
}

/// A document whose blocks are shared: what a `TextView` keeps of what it
/// read.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Parsed {
    /// The blocks, in order.
    pub(crate) blocks: Vec<SharedBlock>,
    /// The footnotes the blocks refer to.
    pub(crate) footnotes: Vec<Footnote>,
}

impl Parsed {
    /// The document, its blocks copied.
    pub(crate) fn document(&self) -> Document {
        Document {
            blocks: self.blocks.iter().map(|b| Block::clone(b)).collect(),
            footnotes: self.footnotes.clone(),
        }
    }

    /// The document, its blocks moved out where nothing else shares them.
    fn into_document(self) -> Document {
        Document {
            blocks: self
                .blocks
                .into_iter()
                .map(|b| Rc::try_unwrap(b.0).unwrap_or_else(|b| Block::clone(&b)))
                .collect(),
            footnotes: self.footnotes,
        }
    }
}

impl From<Document> for Parsed {
    fn from(document: Document) -> Self {
        Self {
            blocks: document.blocks.into_iter().map(SharedBlock::new).collect(),
            footnotes: document.footnotes,
        }
    }
}

/// What a `TextView` keeps of the Markdown it read, to read only the end of
/// a text that grew (the module's documentation).
#[derive(Default)]
pub(crate) struct Incremental {
    /// The parser the text was read with; `None` before the first text.
    parser: Option<Parser>,
    /// The text read last, its line endings `\n`: the string the view was
    /// given, shared with it, unless it had other line endings.
    text: SharedString,
    prefix: Prefix,
}

/// The part of a text that is final.
#[derive(Default)]
struct Prefix {
    /// Where it ends in the text.
    end: usize,
    /// Where it ends in the text as parsed (`super::prepare`), and how
    /// many lines it has: where the positions of the blocks after it start
    /// in the whole text's tree.
    parsed: usize,
    lines: usize,
    /// Its blocks.
    blocks: Vec<SharedBlock>,
    /// The anchors of its headings.
    slugger: Slugger,
    /// The text holds what needs all of it read on every change (a
    /// definition): so will every text it starts.
    whole: bool,
}

impl Incremental {
    /// Markdown `source` read with `parser`, as [`Parser::markdown`] reads
    /// it.
    pub(crate) fn parse(&mut self, parser: &Parser, source: &SharedString) -> Parsed {
        self.parse_in_steps(parser, source, STEP)
    }

    /// [`Self::parse`], a long text read `step` bytes of lines at a time.
    fn parse_in_steps(&mut self, parser: &Parser, source: &SharedString, step: usize) -> Parsed {
        if !incremental(parser) {
            self.clear();
            return parse_whole(parser, source).into();
        }
        let text = if source.contains('\r') {
            source.replace("\r\n", "\n").replace('\r', "\n").into()
        } else {
            source.clone()
        };
        // A plugin may read any of the source (`ParseContext::source`):
        // what it made of a shorter text is not final. A text read with
        // plugins is read from its start every time, a long one in parts.
        let grew = parser.plugins.is_empty()
            && self.parser.as_ref().is_some_and(|p| same(p, parser))
            && text.starts_with(self.text.as_str());
        let read = if grew {
            self.text.len()
        } else {
            self.parser = Some(parser.clone());
            self.prefix = Prefix::default();
            0
        };
        self.text = text;
        // Plugins read the parts as one parse shows them: in the whole text
        // as parsed, at its positions. A text read at once is that already.
        let whole = (!parser.plugins.is_empty() && self.text.len() > 2 * step)
            .then(|| super::prepare(parser, super::Source::original(&self.text)));
        let whole = whole.as_ref();
        if !self.prefix.whole {
            self.prefix.advance(parser, &self.text, whole, read, step);
            if let Some(parsed) = self.prefix.read(parser, &self.text, whole) {
                return parsed;
            }
        }
        parse_whole(parser, &self.text).into()
    }

    /// Forgets the text: the next one is read whole.
    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    /// Where the final part of the text ends.
    #[cfg(test)]
    fn boundary(&self) -> usize {
        self.prefix.end
    }
}

/// About how much text past the boundary a read of a long text takes (the
/// module's documentation). A text no more than twice as long past the
/// boundary is read at once.
const STEP: usize = 32 * 1024;

/// Markdown `source` read with `parser` a [`STEP`] of lines at a time,
/// when it is long: the document [`parse_whole`] makes of it. `None` when
/// it is read whole.
pub(super) fn parse_long(parser: &Parser, source: &str) -> Option<Document> {
    parse_long_in_steps(parser, source, STEP)
}

fn parse_long_in_steps(parser: &Parser, source: &str, step: usize) -> Option<Document> {
    if source.len() <= 2 * step || !incremental(parser) {
        return None;
    }
    let parsed = Incremental::default().parse_in_steps(parser, &source.to_owned().into(), step);
    Some(parsed.into_document())
}

/// Whether text read with `parser` can be read from a boundary on: nothing
/// of it reads the whole source.
fn incremental(parser: &Parser) -> bool {
    !parser.options.mdx
        && parser.extensions.iter().all(|e| e.container.is_none())
        && super::plugins_keep_constructs(parser)
}

fn same(a: &Parser, b: &Parser) -> bool {
    a.options == b.options && a.extensions == b.extensions && a.plugins == b.plugins
}

/// What a read of a text gives besides the blocks before the boundary.
enum Read {
    /// The whole document: the text, read from its start, defines a link
    /// or a footnote.
    Whole(Document),
    /// The blocks after the boundary.
    Open(Vec<Block>),
}

impl Prefix {
    /// `text` read from the boundary on, which moves as far as the text
    /// allows. `None` when the whole text is to be parsed. `whole` is the
    /// text as parsed, for plugins (`settle`).
    fn read(
        &mut self,
        parser: &Parser,
        text: &str,
        whole: Option<&super::Source>,
    ) -> Option<Parsed> {
        let open = match self.settle(parser, text, whole, true)? {
            Read::Whole(document) => return Some(document.into()),
            Read::Open(open) => open,
        };
        let mut blocks = Vec::with_capacity(self.blocks.len() + open.len());
        blocks.extend(self.blocks.iter().cloned());
        blocks.extend(open.into_iter().map(SharedBlock::new));
        Some(Parsed {
            blocks,
            footnotes: Vec::new(),
        })
    }

    /// Moves the boundary through `text` past `read` (what an earlier
    /// read took), when that is long, in reads of lines of about `step`
    /// bytes past the last one, each from the boundary on (the module's
    /// documentation). What is left past the last of them, `step` bytes at
    /// least, is the next read's.
    fn advance(
        &mut self,
        parser: &Parser,
        text: &str,
        whole: Option<&super::Source>,
        read: usize,
        step: usize,
    ) {
        let mut cut = read.max(self.end);
        if text.len() - cut <= 2 * step || may_define(&text[self.end..]) {
            return;
        }
        let mut to = cut + step;
        while !self.whole {
            // A read ends where a boundary may: after a line that follows
            // a blank line. Lines with none between them (a long list, a
            // table, code) are not read for nothing.
            let Some(next) = after_blank(text, to) else {
                return;
            };
            if text.len() - next < step {
                return;
            }
            cut = next;
            let end = self.end;
            match self.settle(parser, &text[..cut], whole, false) {
                Some(Read::Open(_)) => {}
                // What is read whole is the last read's.
                Some(Read::Whole(_)) | None => return,
            }
            // Where the boundary stayed, the next read goes twice as far.
            to = if self.end > end {
                cut + step
            } else {
                self.end + 2 * (cut - self.end)
            };
        }
    }

    /// `text` read from the boundary on, which moves as far as the text
    /// allows; the blocks after it converted when `open`. `None` when the
    /// whole text is to be parsed.
    ///
    /// Plugins are shown what one parse of the whole text shows them: the
    /// source `whole` (the text as parsed; `None` when `text` is all of
    /// it and read at once) and positions in it.
    fn settle(
        &mut self,
        parser: &Parser,
        text: &str,
        whole: Option<&super::Source>,
        open: bool,
    ) -> Option<Read> {
        let tail = &text[self.end..];
        let first = self.end == 0;
        // A definition in the tail has the whole text read: when a line of
        // the tail looks like one, the tail's tree would be made only to be
        // dropped, so the text is read from its start at once.
        if !first && may_define(tail) {
            *self = Self::default();
            return self.settle(parser, text, whole, open);
        }
        // Where the lines after a blank line start, for the repair's scan.
        let mut blanks = Vec::new();
        let repaired = if parser.options.streaming {
            repair_tail(tail, &mut |at| blanks.push(at))?
        } else {
            blank_lines(tail, &mut |at| blanks.push(at));
            Cow::Borrowed(tail)
        };
        // The repair changes the last block alone: the text before its
        // first change is as written.
        let unchanged = tail
            .bytes()
            .zip(repaired.bytes())
            .take_while(|(a, b)| a == b)
            .count();
        // The same for the rewrite's scan, with where each is in what it
        // wrote.
        let mut written = Vec::new();
        let source = if parser.options.math {
            Cow::Owned(latex::rewrite_blanks(&repaired, &mut |at, to| {
                written.push((at, to))
            }))
        } else {
            repaired
        };

        // The repair can make one (`[docs][: /guide`, its open `[` removed).
        if !first && matches!(source, Cow::Owned(_)) && may_define(&source) {
            *self = Self::default();
            return self.settle(parser, text, whole, open);
        }
        let mut tree = tree(parser, super::Source::original(&source), first);
        let nodes = tree.root.children().map_or(&[][..], Vec::as_slice);
        if let Some((last, before)) = nodes.split_last() {
            // A definition in a block that is closed stays: so does the
            // need to read the whole text.
            self.whole = before.iter().any(defines);
            if self.whole || defines(last) {
                // A definition changes the blocks before the boundary too
                // (references to it resolve, footnotes are numbered): the
                // whole text is read, now and, from its start, next time.
                if !first {
                    *self = Self::default();
                    return None;
                }
                // A read before the last one moves the boundary only.
                if !open {
                    return Some(Read::Whole(Document::default()));
                }
                // The tree is the whole text's, definitions included: it
                // is the document, with no second parse.
                let mut converter =
                    Converter::new(parser, &tree.source, std::slice::from_ref(&tree), false);

                let mut blocks = Vec::new();
                converter.blocks_into(nodes, &mut blocks);
                let (footnotes, _) = converter.footnotes();
                return Some(Read::Whole(Document { blocks, footnotes }));
            }
        }
        // Front matter is the first lines up to its closing line: until
        // that arrives they are a rule and text.
        let frontmatter = first
            && parser.options.frontmatter
            && (tail.starts_with("---") || tail.starts_with("+++"))
            && !matches!(nodes.first(), Some(Node::Yaml(_) | Node::Toml(_)));
        let boundary = if frontmatter {
            None
        } else {
            boundary(parser, tail, unchanged, &blanks, &written, &tree)
        };
        let (at, to, count) = boundary.unwrap_or((0, 0, 0));
        let lines = tree.source[..to].bytes().filter(|&b| b == b'\n').count();

        // What a plugin reads is the whole text's: the tail's tree moved to
        // where the tail is in it (it starts a line, so columns stay).
        let converted = match whole {
            Some(whole) => {
                // The tail is repaired and rewritten as the end of the
                // whole text is (the module's documentation); a read before
                // the last one ends early, so only up to the boundary.
                debug_assert!(
                    if open {
                        whole[self.parsed..] == *tree.source
                    } else {
                        whole[self.parsed..].starts_with(&tree.source[..to])
                    },
                    "a tail is parsed as the whole text is"
                );
                shift(&mut tree.root, self.parsed, self.lines);
                whole
            }
            None => {
                debug_assert!(
                    parser.plugins.is_empty() || self.end == 0,
                    "plugins read a tail in the whole text"
                );
                &tree.source
            }
        };
        let nodes = tree.root.children().map_or(&[][..], Vec::as_slice);
        let mut converter = Converter::new(parser, converted, std::slice::from_ref(&tree), false);
        converter.slugger = std::mem::take(&mut self.slugger);
        let mut done = Vec::new();
        converter.blocks_into(&nodes[..count], &mut done);
        let mut after = Vec::new();
        if open {
            converter.slugger.mark();
            converter.blocks_into(&nodes[count..], &mut after);
            converter.slugger.rewind();
        }
        self.slugger = std::mem::take(&mut converter.slugger);

        self.end += at;
        self.parsed += to;
        self.lines += lines;
        self.blocks.extend(done.into_iter().map(SharedBlock::new));
        Some(Read::Open(after))
    }
}

/// The last line of `tail` a boundary can move to (the module's
/// documentation): its offset in `tail` and in the tail as parsed, and how
/// many of the tree's blocks are before it.
fn boundary(
    parser: &Parser,
    tail: &str,
    unchanged: usize,
    blanks: &[usize],
    written: &[(usize, usize)],
    tree: &Tree,
) -> Option<(usize, usize, usize)> {
    let nodes = tree.root.children()?;
    let splits = splits(parser, nodes);
    blanks.iter().rev().find_map(|&at| {
        // The line before is blank as written, not only a quote's or an
        // item's marker (which the scans read as blank).
        let before = &tail[..at.checked_sub(1)?];
        let blank = &before[before.rfind('\n').map_or(0, |i| i + 1)..];
        // The line has ended, shows text, and is as written.
        let end = at + tail[at..].find('\n')?;
        if !blank.trim().is_empty() || tail[at..end].trim().is_empty() || end >= unchanged {
            return None;
        }
        // Where the line is in the text as parsed.
        let to = if parser.options.math {
            let i = written.binary_search_by_key(&at, |&(at, _)| at).ok()?;
            written[i].1
        } else {
            at
        };
        // A block starts on the line, the blocks before it ended.
        let count = nodes.partition_point(|n| n.position().is_some_and(|p| p.start.offset < to));
        let start = nodes.get(count)?.position()?.start.offset;
        // The block before is a paragraph (or there is none): where the
        // parser is back in the state it starts a text in (the module's
        // documentation).
        let ended = match count.checked_sub(1) {
            Some(last) => {
                nodes[last].position()?.end.offset <= to
                    && matches!(nodes[last], Node::Paragraph(_))
            }
            None => true,
        };
        let on_line = !tree.source.get(to..start)?.contains('\n');
        (ended && on_line && splits[count]).then_some((at, to, count))
    })
}

/// Whether a line of `source` (a tail: it starts outside code) looks like
/// a definition of a link or a footnote: outside fenced code, at the start
/// of a block, a label and a colon (`[docs]:`, `[^a]:`), and after a
/// link's a destination with nothing but a title behind it.
///
/// A guess, to save reading a tail whose tree would be dropped. The tree
/// alone says whether there is a definition ([`defines`]): a wrong guess
/// costs time, never a block. It is narrow on purpose: `]:` is all over
/// code and prose (`if seen[key]:`, `[12:00]: build started`), and a guess
/// that took those would read every such reply whole.
fn may_define(source: &str) -> bool {
    if !source.contains("]:") {
        return false;
    }
    // The fence of the code a line is in: its character and length.
    let mut fence: Option<(u8, usize)> = None;
    // Whether a block can start on the line: the first line, one after a
    // blank line, after code, a heading or a rule (a definition does not
    // interrupt a paragraph).
    let mut starts = true;
    // How many quotes the line before is in: a quote interrupts.
    let mut quotes = 0;
    let mut at = 0;
    while at < source.len() {
        let end = source[at..].find('\n').map_or(source.len(), |i| at + i);
        let line = &source[at..end];
        let next = end + 1;
        // The markers of the quotes and items the line is in.
        let mut rest = line;
        let mut item = false;
        let mut depth = 0;
        loop {
            rest = rest.trim_start_matches([' ', '\t']);
            if let Some(quoted) = rest.strip_prefix('>') {
                rest = quoted;
                depth += 1;
            } else if fence.is_none()
                && let Some(marked) = list_marker(rest)
            {
                rest = marked;
                item = true;
            } else {
                break;
            }
        }
        let bytes = rest.as_bytes();
        let run = match bytes.first() {
            Some(&c @ (b'`' | b'~')) => {
                let n = bytes.iter().take_while(|&&b| b == c).count();
                // A backtick in what follows makes it a code span.
                (n >= 3 && (c == b'~' || fence.is_some() || !rest[n..].contains('`')))
                    .then_some((c, n))
            }
            _ => None,
        };
        match (fence, run) {
            (Some((c, n)), Some((d, m))) if c == d && m >= n && rest[m..].trim().is_empty() => {
                fence = None;
                starts = true;
            }
            (Some(_), _) => {}
            (None, Some(open)) => fence = Some(open),
            (None, None) => {
                if rest.trim().is_empty() {
                    starts = true;
                } else {
                    // A footnote's definition holds blocks, as an item
                    // does: it interrupts a paragraph, a link's does not.
                    let defined = (starts || item || depth > quotes || rest.starts_with("[^"))
                        && rest.starts_with('[')
                        && labelled(&source[end - rest.len()..]);
                    if defined {
                        return true;
                    }
                    // A heading, or a rule or a heading's underline.
                    let text = rest.trim();
                    starts = text.starts_with('#')
                        || ['-', '=', '*', '_']
                            .iter()
                            .any(|&c| text.chars().all(|d| d == c || d == ' '));
                }
            }
        }
        quotes = depth;
        at = next;
    }
    false
}

/// The end of the first line from `from` on that follows a blank line
/// (spaces and tabs at most), counted in bytes (`\n` is never inside a
/// character); `None` when there is none or it has not ended.
fn after_blank(text: &str, from: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let line_end = |at: usize| {
        bytes
            .get(at..)?
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| at + i)
    };
    let mut at = from;
    loop {
        let start = line_end(at)? + 1;
        let blank = bytes[start..]
            .iter()
            .take_while(|&&b| b == b' ' || b == b'\t')
            .count();
        if bytes.get(start + blank) == Some(&b'\n') {
            return line_end(start + blank + 1).map(|end| end + 1);
        }
        at = start;
    }
}

/// `line` after the marker of a list item it starts with, if any.
fn list_marker(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    let marker = match bytes.get(digits)? {
        b'-' | b'*' | b'+' if digits == 0 => 1,
        b'.' | b')' if (1..=9).contains(&digits) => digits + 1,
        _ => return None,
    };
    matches!(bytes.get(marker), Some(b' ' | b'\t')).then(|| &line[marker + 1..])
}

/// Whether `text`, which starts with `[`, starts with a label and a colon
/// that may be a definition's: a footnote's, or a link's with a
/// destination and at most a title after it on the line.
fn labelled(text: &str) -> bool {
    let bytes = text.as_bytes();
    // A label is 999 characters at most and holds no blank line.
    let mut i = 1;
    let close = loop {
        match bytes.get(i) {
            Some(b'\\') => i += 1,
            Some(b']') => break i,
            Some(b'[') | None => return false,
            Some(b'\n') if bytes.get(i + 1) == Some(&b'\n') => return false,
            _ => {}
        }
        i += 1;
        if i > 1000 {
            return false;
        }
    };
    if bytes.get(close + 1) != Some(&b':') || text[1..close].trim().is_empty() {
        return false;
    }
    if bytes[1] == b'^' {
        return true;
    }
    // The destination, which may be on the next line (after its markers).
    let after = text[close + 2..].trim_start_matches([' ', '\t']);
    let after = match after.strip_prefix('\n') {
        Some(line) => line.trim_start_matches([' ', '\t', '>']),
        None => after,
    };
    if after.starts_with('<') {
        return true;
    }
    let destination = after.find([' ', '\t', '\n']).unwrap_or(after.len());
    if destination == 0 {
        return false;
    }
    // After it the line ends, or a title starts.
    let behind = after[destination..].trim_start_matches([' ', '\t']);
    matches!(
        behind.as_bytes().first(),
        None | Some(b'\n' | b'"' | b'\'' | b'(')
    )
}

/// The positions in `node` moved `offset` bytes and `lines` lines on.
fn shift(node: &mut Node, offset: usize, lines: usize) {
    if offset == 0 && lines == 0 {
        return;
    }
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if let Some(position) = node.position_mut() {
            for point in [&mut position.start, &mut position.end] {
                point.offset += offset;
                point.line += lines;
            }
        }
        if let Some(children) = node.children_mut() {
            stack.extend(children.iter_mut());
        }
    }
}

/// Whether a definition of a link or a footnote is in `node`.
fn defines(node: &Node) -> bool {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if matches!(node, Node::Definition(_) | Node::FootnoteDefinition(_)) {
            return true;
        }
        stack.extend(node.children().into_iter().flatten());
    }
    false
}

/// For each count of the first of `nodes` (blocks of the top level), whether
/// reading them alone gives the blocks that reading all of `nodes` starts
/// with, whatever nodes come after: no HTML element is open after them. An
/// element opened by a tag on lines of its own is closed by a later tag
/// (`Converter::html_element`), and holds the nodes between them.
fn splits(parser: &Parser, nodes: &[Node]) -> Vec<bool> {
    let empty = super::Source::default();
    let converter = Converter::new(parser, &empty, &[], false);
    let mut splits = vec![false; nodes.len() + 1];
    // The first count after every element opened so far.
    let mut closed = 0;
    for (i, node) in nodes.iter().enumerate() {
        splits[i] = i >= closed;
        if parser.options.html
            && let Node::Html(html) = node
            && let Some(name) = unclosed_element(&html.value).filter(|n| converter.is_element(n))
        {
            match matching_close(nodes, i, name) {
                Some(close) => closed = closed.max(close + 1),
                // Its closing tag may still come: nothing after is final.
                None => return splits,
            }
        }
    }
    splits[nodes.len()] = nodes.len() >= closed;
    splits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text_view::{
        CustomNode, Inline, MarkdownExtension, MarkdownOptions, MarkdownPlugin, ParseContext, mdast,
    };

    /// `text` as a view is given it.
    fn shared(text: &str) -> SharedString {
        text.to_owned().into()
    }

    fn parser(streaming: bool) -> Parser {
        Parser::new().options(MarkdownOptions {
            streaming,
            ..MarkdownOptions::default()
        })
    }

    /// A plugin that shows what it is given. Paragraphs, headings, code,
    /// formulas and tables are custom nodes, inline code and formulas too,
    /// of the node's source as the context gives it, where the node starts
    /// and ends (offset, line, column) and how long the whole source is.
    /// Like an app's plugin, it configures what is read inside a paragraph.
    struct Where;

    impl MarkdownPlugin for Where {
        fn name(&self) -> &str {
            "where"
        }

        fn configure(&self, options: &mut markdown::ParseOptions) {
            options.gfm_strikethrough_single_tilde = false;
        }

        fn block(&self, node: &mdast::Node, cx: &mut ParseContext<'_>) -> Option<Block> {
            let content = match node {
                mdast::Node::Paragraph(p) => cx.inlines(&p.children),
                mdast::Node::Heading(h) => cx.inlines(&h.children),
                mdast::Node::Code(_) | mdast::Node::Math(_) | mdast::Node::Table(_) => Vec::new(),
                _ => return None,
            };
            Some(Block::Custom(where_node(node, cx).with_content(content)))
        }

        fn inline(&self, node: &mdast::Node, cx: &mut ParseContext<'_>) -> Option<Inline> {
            matches!(
                node,
                mdast::Node::InlineCode(_) | mdast::Node::InlineMath(_)
            )
            .then(|| Inline::Custom(where_node(node, cx)))
        }
    }

    fn where_node(node: &mdast::Node, cx: &ParseContext<'_>) -> CustomNode {
        let at = node.position().map_or(String::new(), |p| {
            format!(
                "{}:{}:{}-{}:{}:{} of {}",
                p.start.offset,
                p.start.line,
                p.start.column,
                p.end.offset,
                p.end.line,
                p.end.column,
                cx.source().len()
            )
        });
        CustomNode::new("where")
            .with_text(cx.node_source(node).unwrap_or_default())
            .with_attribute("at", at)
    }

    /// `source` arriving `step` bytes at a time (to the next character),
    /// read by one [`Incremental`] and, each time, by `parser` whole: the
    /// documents are the same. Returns where the boundary is at the end.
    #[track_caller]
    fn grow(parser: &Parser, source: &str, step: usize) -> usize {
        let mut incremental = Incremental::default();
        let mut end = 0;
        while end < source.len() {
            end = (end + step).min(source.len());
            while !source.is_char_boundary(end) {
                end += 1;
            }
            let text = &source[..end];
            let read = incremental.parse(parser, &shared(text)).document();
            assert_eq!(
                read,
                parser.markdown(text),
                "after {end} bytes of {} in steps of {step}: {text:?}",
                source.len()
            );
        }
        incremental.boundary()
    }

    /// [`grow`] in steps of several sizes, with and without the streaming
    /// repair. Returns the least the boundary reached.
    #[track_caller]
    fn grows(source: &str) -> usize {
        grows_with(|parser| parser, source)
    }

    #[track_caller]
    fn grows_with(with: impl Fn(Parser) -> Parser, source: &str) -> usize {
        let mut least = usize::MAX;
        for streaming in [true, false] {
            let parser = with(parser(streaming));
            for step in [1, 2, 3, 5, 7, 13, 24, 64] {
                least = least.min(grow(&parser, source, step));
                // With a plugin, which is shown what one parse shows it.
                grow(&parser.clone().plugin(Where), source, step);
            }
        }
        least
    }

    /// Where the boundary ends up in a document of paragraphs with a blank
    /// line between them: at the last line after a blank line that ended.
    fn last_block(source: &str) -> usize {
        let mut at = 0;
        let mut from = 0;
        while let Some(i) = source[from..].find("\n\n") {
            let start = from + i + 2;
            if !source[start..].starts_with('\n') && source[start..].contains('\n') {
                at = start;
            }
            from += i + 1;
        }
        at
    }

    const HEADINGS: &str = "# Intro\n\nSome text with **bold** and `code`.\n\n## Usage\n\nFirst.\n\n## Usage\n\nSecond, same name.\n\n### Usage\n\nThird.\n\nSetext\n======\n\nMore\n----\n\n## Intro\n\n#hashtag is text, # alone is a heading\n\npara\n#\n\npara\n#tag\n\n## Usage\n\nThe end.\n";

    const LISTS: &str = "Tight:\n\n- one\n- two with *emphasis*\n- three\n\nLoose once a blank line comes:\n\n- one\n- two\n\n- three\n\nNested:\n\n1. first\n   - inner a\n   - inner b\n\n     a paragraph of inner b\n2. second\n\n   ```rust\n   let x = 1;\n\n   let y = 2;\n   ```\n3. third\n\nTasks:\n\n- [ ] open\n- [x] done\n\n* another list\n+ and another\n\n10. ten\n11. eleven\n\nAfter the lists.\n";

    const QUOTES: &str = "> A quote\n> on two lines\nand a lazy one.\n\n> First quote.\n\n> Second quote.\n>\n> > Nested **quote**\n> > more\n>\n> - item in a quote\n> - another\n\n> [!NOTE]\n> A note with `code`.\n\n> [!WARNING]\n> Careful.\n>\n> Second paragraph.\n\n> [!TIP]\n\nText after.\n";

    const TABLES: &str = "Here are the fields:\n\n| Name | Type | Notes |\n|:---|:---:|---:|\n| `a` | `u32` | see `docs` |\n| `b` | `Option<u32>` | a \\| pipe |\nstill a row\n\nA paragraph.\n\na | b\n--|--\n1 | 2\n\n| lonely header |\n\n| x |\n|---|\n\nDone.\n";

    const CODE: &str = "Here is the program:\n\n```rust\nfn main() {\n\n    println!(\"hi\");\n}\n```\n\n~~~\ntildes\n```\nstill tildes\n~~~\n\n    indented code\n\n    still the same block\n\nText.\n\n````md\n```\nnested\n```\n````\n\npara\n```js\nright after a paragraph\n```\nand text right after\n\n```\nnever closed\n\n# not a heading\n";

    const MATH: &str = "Inline $x^2$ and \\(y^2\\) and costs $5 and $10.\n\n$$\na = b\n\nc = d\n$$\n\nDisplay:\n\n\\[\nx = 1\n\\]\n\n\\[ e = mc^2 \\]\n\nRefs \\[1\\]\\[3\\] and `\\(code\\)`.\n\n$$ one line $$\n\n```math\nfenced\n```\n\n$$\n```\n$$\n\nAfter \\(a\n+ b\\) the end.\n";

    const HTML: &str = "<details>\n<summary>More</summary>\n\nHidden **text**.\n\n- a list\n\n</details>\n\nBetween.\n\n<div align=\"center\">\n\ncentered\n\n</div>\n\n<!-- a comment\n\nover a blank line -->\n\n<pre>\nkept\n\n  as written\n</pre>\n\nInline <b>bold *em*</b> and <kbd>K</kbd> and <US tech>.\n\n<blockquote>\n\nquoted\n\n</blockquote>\n\n<details>\n\nnever closed\n\n## A heading\n\ntext\n";

    const DEFINITIONS: &str = "See [the docs][docs] and [docs] and ![logo].\n\n## Part\n\nMore text about [docs].\n\n- a list\n\n[docs]: https://example.com \"Docs\"\n\nAfter the definition, [docs] again.\n\n[logo]: https://example.com/logo.png\n\nThe end.\n";

    const FOOTNOTES: &str = "First[^b] and second[^a] and unknown[^c].\n\n## Part\n\nAgain[^a].\n\n[^a]: The note a.\n\n    Its second paragraph.\n\n[^b]: The note b, with [^a].\n\nThe end[^b].\n";

    const CJK: &str = "# 标题\n\n这是**涨幅：**5%，还有*强调*和`代码`。\n\n## 标题\n\n链接 https://example.com。下一句，和 https://zh.wikipedia.org/wiki/中文 以及 www.example.com，结束。\n\n- 列表项一\n- 列表项二：**重点**内容\n\n| 名称 | 说明 |\n|---|---|\n| 甲 | 第一个 |\n\n> 引用的文字，～～不是删除～～，~~是删除~~。\n\n日本語のテキストと한국어 텍스트。\n\n## 标题\n\n公式 \\[注\\] 与 \\(x\\) 结束\n";

    const INLINE: &str = "A [link](https://example.com \"title\"), an ![image](a.png), <https://auto.link> and https://bare.link/path.\n\nHard  \nbreak and a\\\nbackslash break.\n\n***\n\n***bold italic*** and ~~gone~~ and a*b and _under_score.\n\n---\n\n1986\\. A great year.\n\n- \n\ntext\n- item after text\n\n2. starts at two\n\nline one\n===\n\n* * *\n\nEnd with an open **bold and `code\n";

    const TYPICAL: &str = "## Section\n\nSome **bold** text with `code`, a [link](https://example.com) and $x^2$.\n\n- item one\n- item two with *emphasis*\n\n```rust\nfn main() { println!(\"hi\"); }\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> A note.\n\n## Section\n\nSome **bold** text with `code`, a [link](https://example.com) and $x^2$.\n\n1. first\n2. second\n\nThe last paragraph, still being written";

    #[test]
    fn headings() {
        // The last block after a paragraph whose first line ended.
        assert_eq!(grows(HEADINGS), HEADINGS.rfind("## Usage").unwrap());
    }

    #[test]
    fn lists() {
        // After that list every block follows a list: no boundary.
        assert_eq!(grows(LISTS), LISTS.find("- [ ] open").unwrap());
    }

    #[test]
    fn quotes_and_alerts() {
        // Every block but the first follows a quote: no boundary.
        assert_eq!(grows(QUOTES), 0);
        let source = format!("Before.\n\n{QUOTES}\nThe end.\n");
        assert_eq!(grows(&source), source.find("The end.").unwrap());
    }

    #[test]
    fn tables() {
        assert_eq!(grows(TABLES), TABLES.find("| x |").unwrap());
    }

    #[test]
    fn code() {
        // The last fence is never closed: the boundary stays before it.
        assert_eq!(grows(CODE), CODE.find("```\nnever closed").unwrap());
    }

    #[test]
    fn math() {
        // The last block after a paragraph. (After it comes a fence the
        // rewrite's scan sees open, as it reads no `$$`: no boundary there
        // either.)
        assert_eq!(grows(MATH), MATH.find("```math").unwrap());
    }

    #[test]
    fn html() {
        // The last block after a paragraph. (The last `<details>` is never
        // closed: nothing after it would be final either.)
        assert_eq!(grows(HTML), HTML.find("<blockquote>").unwrap());
    }

    #[test]
    fn cjk() {
        assert_eq!(grows(CJK), CJK.rfind("## 标题").unwrap());
    }

    #[test]
    fn inline() {
        assert_eq!(grows(INLINE), INLINE.find("- \n\ntext").unwrap());
    }

    #[test]
    fn typical() {
        assert_eq!(grows(TYPICAL), TYPICAL.find("1. first").unwrap());
    }

    /// Where `markdown-rs` reads a block by what came before it, across a
    /// blank line: no boundary may stand between them (random documents
    /// found these).
    #[test]
    fn blocks_read_by_what_came_before() {
        // A list is closed by the paragraph after it, which `2)` then
        // interrupts (it does not interrupt the first paragraph of a text).
        grows("- [ ] item\n| --www.a.dev。<pre>\n\n。(| 1 | 2 |\n2) 标题：</b>\n\nEnd.\n");
        // A quote whose paragraph went on without `>` stays open over the
        // blank line: the HTML block after it ends before its blank lines.
        grows("> [!NOTE]\n**</details>\n**a | b\n| 1 | 2 |\n\n<pre>\n===\n- [ ] <pre>\n$\n\n<");
        // A row of cells cut short by a quote: the quote stays open across
        // the code after it, to the same effect.
        grows("|---|---|\n>\n```\ncode\n```\n\n<pre>\n| a | b |\n\n\n---");
        grows("| a |\n>\n# Title\n\n***\n\n<pre>\nx\n\n\n\nText.\n\nEnd.\n");
    }

    #[test]
    fn carriage_returns() {
        let source = TYPICAL.replace('\n', "\r\n");
        // The boundary is in the text with `\n` line endings.
        assert_eq!(grows(&source), TYPICAL.find("1. first").unwrap());
        grows(&HEADINGS.replace('\n', "\r"));
    }

    /// A definition changes the blocks before it: once one is in a closed
    /// block, the whole text is read.
    #[test]
    fn definitions_arriving_late() {
        let before = DEFINITIONS.find("[docs]:").unwrap();
        assert!(grows(DEFINITIONS) <= before);
        // Until then the boundary moves.
        assert_eq!(
            grows(&DEFINITIONS[..before]),
            DEFINITIONS.find("- a list").unwrap()
        );
    }

    #[test]
    fn footnotes_arriving_late() {
        let before = FOOTNOTES.find("[^a]:").unwrap();
        assert!(grows(FOOTNOTES) <= before);
        let read = Incremental::default().parse(&parser(true), &FOOTNOTES.into());
        assert_eq!(read.footnotes.len(), 2);
    }

    #[test]
    fn definitions_set_and_replaced() {
        let nested = "# Part\n\nSee [docs] and ![logo] and note[^b].\n\n## Part\n\nAgain[^a].\n\n> [docs]: /docs \"Docs\"\n>\n> - [logo]: /logo.png\n\n[^a]: # Part\n\n    Links [docs] and [^b].\n\n[^b]: Second note [^a].";
        let plain = "# Part\n\nText.\n\n## Part\n\nMore.\n\nEnd.\n";
        for streaming in [false, true] {
            let parser = parser(streaming);
            for source in [DEFINITIONS, FOOTNOTES, nested] {
                let read = Prefix::default()
                    .read(&parser, source, None)
                    .expect("the tree read from the start can be converted");
                assert_eq!(read.document(), parser.markdown(source));
                let mut incremental = Incremental::default();
                for text in [source, plain, source] {
                    assert_eq!(
                        incremental.parse(&parser, &shared(text)).document(),
                        parser.markdown(text),
                        "streaming {streaming}: {text:?}"
                    );
                }
                let edited = source.replace("Part", "Changed");
                assert_eq!(
                    incremental.parse(&parser, &shared(&edited)).document(),
                    parser.markdown(&edited)
                );
                assert_eq!(
                    incremental.parse(&parser, &shared(plain)).document(),
                    parser.markdown(plain)
                );
                assert!(incremental.boundary() > 0);
            }
        }
        grows(nested);
    }

    #[test]
    fn definitions_in_the_open_tail() {
        for tail in [
            "[docs]: https://example.com/guide \"Docs\"",
            "[^a]: First [^b].\n\n[^b]: Second [^a].\n\n    More [docs].",
            // The streaming repair can turn this into a definition even
            // though the source has no adjacent closing bracket and colon.
            "[docs][: /guide",
        ] {
            grows(&format!(
                "See [docs] and [^a].\n\n## Part\n\nA paragraph.\n\n{tail}"
            ));
        }
    }

    /// The guess that saves a tail's tree takes what starts a block as a
    /// definition does, and leaves the `]:` of code and prose.
    #[test]
    fn lines_that_may_define() {
        for source in [
            "[docs]: /guide",
            "[docs]: /guide \"Docs\"\n",
            "[docs]: </a guide>",
            "[^a]: A note",
            "Text.\n\n   [docs]: /guide\n",
            "Text.\n\n[docs]:\n/guide\n",
            "Text.\n\n[do\ncs]: /guide\n",
            "> Quoted.\n>\n> [docs]: /guide",
            "> [docs]:\n> /guide",
            "- item\n- [logo]: /logo.png\n",
            "1. [^a]: note",
            "Text\n[^n]: note\n",
            "```\ncode\n```\n[docs]: /guide\n",
            "```a``` text\n\n[docs]: /guide\n",
            "# Heading\n[docs]: /guide\n",
            "Title\n===\n[docs]: /guide\n",
            "Text.\n\n---\n[^a]: note\n",
            "Paragraph.\n> [docs]: /guide\n",
            "[a]: /a\n[b]: /b invalid\n",
            DEFINITIONS,
            FOOTNOTES,
        ] {
            assert!(may_define(source), "{source:?}");
        }
        for source in [
            "No marker at all.",
            "```python\nif seen[key]:\n    total += counts[key]\n```\n",
            "```md\n[docs]: /guide\n```\n",
            "~~~\n[docs]: /guide\n",
            "Sources:\n[1]: https://example.com\n",
            "Text\n[n]: /url\n",
            "[12:00]: build started\n",
            "[docs]: /guide invalid\n",
            "[docs]:",
            "[docs]: ",
            "[]: /guide",
            "- [ ] task: later\n",
            "Text `[docs]: /guide`.\n",
            "items[0]: first\n",
            "[link](/url): text\n",
            "[a [b]: /c\n",
        ] {
            assert!(!may_define(source), "{source:?}");
        }
    }

    /// A definition arriving in a tail that the guess misses (indented
    /// code that looks like a fence's start, a table's last row before it)
    /// or takes for one that is none: the document is the whole text's
    /// either way.
    #[test]
    fn definitions_the_guess_misses() {
        let fence = "Text.\n\n    ```\n\n[docs]: /guide";
        assert!(!may_define(fence));
        for tail in [
            fence,
            "| a |\n|---|\n| 1 |\n[docs]: /guide",
            "- item\n\n  text\n  > [docs]: /guide \"Docs\"",
            "<div>\n\n[docs]: /guide\n\n</div>",
            "[12:00]: 'build started'",
        ] {
            grows(&format!(
                "See [docs] and [^a].\n\n## Part\n\nA paragraph.\n\nMore.\n\n{tail}\n\nEnd [docs].\n"
            ));
        }
    }

    /// `]:` in code or in a code span is no definition: what was kept of
    /// the text stays kept while it arrives.
    #[test]
    fn literal_markers_keep_the_boundary() {
        let source = "Intro.\n\nFirst.\n\n```python\nif seen[key]:\n    total += counts[key]\n```\n\nText `[docs]: /guide`.\n\nEnd.\n";
        for streaming in [false, true] {
            let parser = parser(streaming);
            let mut incremental = Incremental::default();
            let mut boundary = 0;
            for end in 1..=source.len() {
                let text = &source[..end];
                assert_eq!(
                    incremental.parse(&parser, &shared(text)).document(),
                    parser.markdown(text)
                );
                assert!(incremental.boundary() >= boundary, "{text:?}");
                boundary = incremental.boundary();
            }
            assert_eq!(boundary, source.find("End.").unwrap());
        }
    }

    #[test]
    fn temporary_definitions_and_literal_markers() {
        for source in [
            // The destination is valid until the unquoted text arrives.
            "See [docs].\n\nParagraph.\n\n[docs]: /guide invalid\n\nAfter.\n\nEnd.\n",
            "Before.\n\n```md\n[docs]: /guide\n```\n\nLiteral `]:` in a paragraph.\n\nAfter.\n\nEnd.\n",
        ] {
            grows(source);
            for streaming in [false, true] {
                let parser = parser(streaming);
                let mut incremental = Incremental::default();
                let initial = source.find(" invalid").map_or(source, |at| &source[..at]);
                for text in [
                    initial.to_owned(),
                    source.to_owned(),
                    format!("{source}\nMore.\n\nLast.\n"),
                ] {
                    assert_eq!(
                        incremental.parse(&parser, &shared(&text)).document(),
                        parser.markdown(&text)
                    );
                }
                assert!(!incremental.prefix.whole);
                assert!(incremental.boundary() > 0);
            }
        }
    }

    #[test]
    fn frontmatter() {
        let source = "---\ntitle: A\n\nauthor: B\n---\n\n# Title\n\nText.\n\nMore.\n";
        let with = |p: Parser| {
            let options = MarkdownOptions {
                frontmatter: true,
                ..p.options
            };
            p.options(options)
        };
        assert_eq!(grows_with(with, source), last_block(source));
        // Never closed: a rule and text, which a closing line would change.
        let open = "---\ntitle: A\n\nauthor: B\n\n# Title\n\nText.\n";
        assert_eq!(grows_with(with, open), 0);
        // Without the option the same lines are a rule and text for good.
        assert_eq!(grows(open), open.find("# Title").unwrap());
    }

    #[test]
    fn extensions() {
        let source = "Hi @ada and @bob.\n\n```chart\n1,2,3\n```\n\n<Callout kind=\"tip\">\n\nInside **it**.\n\n</Callout>\n\nAfter @eve.\n\nThe end.\n";
        let with = |p: Parser| {
            p.extension(MarkdownExtension::pattern("mention", r"@(\w+)"))
                .extension(MarkdownExtension::language("chart", "chart"))
                .extension(MarkdownExtension::tag("callout", "callout"))
        };
        assert_eq!(grows_with(with, source), last_block(source));
    }

    /// What reads the whole source is read whole: containers, MDX, plugins.
    #[test]
    fn whole_source_readers() {
        struct Shout;
        impl MarkdownPlugin for Shout {
            fn name(&self) -> &str {
                "shout"
            }
            fn inline(&self, node: &mdast::Node, cx: &mut ParseContext<'_>) -> Option<Inline> {
                matches!(node, mdast::Node::Strong(_))
                    .then(|| Inline::text(format!("{}", cx.source().len())))
            }
        }
        let source = "Intro **x**.\n\n:::note[Heads up]\n\nInside.\n\n:::\n\n<Tag a=\"b\">\n\ntext {1 + 1}\n\n</Tag>\n\nThe **end**.\n";
        // A plugin that turns a construct on or off: the text's blocks are
        // not the ones the parser's options make.
        struct Html;
        impl MarkdownPlugin for Html {
            fn name(&self) -> &str {
                "no-html"
            }
            fn configure(&self, options: &mut markdown::ParseOptions) {
                options.constructs.html_flow = false;
            }
        }
        let container = |p: Parser| p.extension(MarkdownExtension::container("note", "note"));
        assert_eq!(grows_with(container, source), 0);
        let mdx = |p: Parser| {
            let options = MarkdownOptions {
                mdx: true,
                ..p.options
            };
            p.options(options)
        };
        assert_eq!(grows_with(mdx, source), 0);
        assert_eq!(grows_with(|p| p.plugin(Html), source), 0);
        assert_eq!(steps_with(|p| p.plugin(Html), &source.repeat(4)), 0);
        // A plugin that reads the whole source: what it made of a text is
        // not kept for the next one (`Shout` counts the bytes: the first
        // paragraph changes with every byte), yet each text is read in
        // parts, its boundary where it is without the plugin.
        assert_eq!(grows_with(|p| p.plugin(Shout), source), grows(source));
        let long = source.repeat(4);
        assert_eq!(
            steps_with(|p| p.plugin(Shout), &long),
            steps_with(|p| p, &long)
        );
        assert!(steps_with(|p| p, &long) > 3 * source.len());
    }

    /// A text that is not the last one with more at its end, or another
    /// parser: read whole, and from there on incrementally again.
    #[test]
    fn replaced_text_and_changed_options() {
        let parser = parser(true);
        let mut incremental = Incremental::default();
        #[track_caller]
        fn read(incremental: &mut Incremental, parser: &Parser, text: &str) -> usize {
            assert_eq!(
                incremental.parse(parser, &shared(text)).document(),
                parser.markdown(text),
                "{text:?}"
            );
            incremental.boundary()
        }
        // Two headings of one name: the second's anchor counts the first.
        let text = "# One\n\nFirst.\n\n# One\n\nSecond.\n\nThird";
        let second = text.find("Second.").unwrap();
        assert_eq!(
            read(&mut incremental, &parser, text),
            text.rfind("# One").unwrap()
        );
        // Shrinks.
        assert_eq!(
            read(&mut incremental, &parser, &text[..second]),
            text.rfind("# One").unwrap()
        );
        assert_eq!(read(&mut incremental, &parser, "# One"), 0);
        // Grows again, from the shorter text.
        assert_eq!(
            read(&mut incremental, &parser, text),
            text.rfind("# One").unwrap()
        );
        // Replaced by a text of the same length, then one that only shares
        // its start.
        let other = text.replacen("One", "Two", 1);
        assert_eq!(
            read(&mut incremental, &parser, &other),
            other.rfind("# One").unwrap()
        );
        let edited = "# Two\n\nFirst!\n\n# One\n\nSecond, and more.\n\nEnd.\n\nEnd";
        assert_eq!(
            read(&mut incremental, &parser, edited),
            edited.find("End.").unwrap()
        );
        // An option changed mid-stream: `$x$` is text now.
        let math = "Costs $x$ here.\n\nAnd $y$";
        assert_eq!(read(&mut incremental, &parser, math), last_block(math));
        let plain = Parser::new().options(MarkdownOptions {
            math: false,
            ..parser.options
        });
        let more = "Costs $x$ here.\n\nAnd $y$ too.\n\nEnd";
        assert_eq!(read(&mut incremental, &plain, more), last_block(more));
        assert_eq!(read(&mut incremental, &parser, more), last_block(more));
        // An extension changed.
        let mentions = parser
            .clone()
            .extension(MarkdownExtension::pattern("mention", r"@(\w+)"));
        let text = "Hi @ada.\n\nAnd @bob.\n\nEnd";
        assert_eq!(read(&mut incremental, &parser, text), last_block(text));
        assert_eq!(read(&mut incremental, &mentions, text), last_block(text));
        // Cleared: read whole again.
        incremental.clear();
        assert_eq!(read(&mut incremental, &mentions, text), last_block(text));
    }

    /// Blocks before the boundary are the same allocations from one read to
    /// the next: comparing two documents compares pointers there.
    #[test]
    fn blocks_are_shared() {
        let parser = parser(true);
        let mut incremental = Incremental::default();
        let first = incremental.parse(&parser, &"One.\n\nFirst.\n\nSecond".into());
        let second = incremental.parse(&parser, &"One.\n\nFirst.\n\nSecond, more.\n\nThird".into());
        let third = incremental.parse(
            &parser,
            &"One.\n\nFirst.\n\nSecond, more.\n\nThird.\n".into(),
        );
        assert_eq!(first.blocks.len(), 3);
        assert_eq!(second.blocks.len(), 4);
        assert!(Rc::ptr_eq(&first.blocks[0].0, &second.blocks[0].0));
        for (a, b) in second.blocks.iter().zip(&third.blocks).take(2) {
            assert!(Rc::ptr_eq(&a.0, &b.0));
        }
        // A block after the boundary is a new one each time, equal by value
        // when its text is the same.
        assert!(!Rc::ptr_eq(&second.blocks[2].0, &third.blocks[2].0));
        assert_eq!(second.blocks[2], third.blocks[2]);
        assert_ne!(second.blocks[3], third.blocks[3]);
        let again = incremental.parse(
            &parser,
            &"One.\n\nFirst.\n\nSecond, more.\n\nThird.\n".into(),
        );
        assert!(Rc::ptr_eq(&third.blocks[2].0, &again.blocks[2].0));
        assert!(!Rc::ptr_eq(&third.blocks[3].0, &again.blocks[3].0));
        assert_eq!(third, again);
    }

    /// `source` given at once and read a `step` of lines at a time, as a
    /// long text is, with and without the streaming repair: the document
    /// one parse of it makes, for each step. Returns the least the boundary
    /// reached.
    #[track_caller]
    fn steps(source: &str) -> usize {
        let least = steps_with(|parser| parser, source);
        // With a plugin, which is shown what one parse shows it.
        assert_eq!(steps_with(|parser| parser.plugin(Where), source), least);
        least
    }

    #[track_caller]
    fn steps_with(with: impl Fn(Parser) -> Parser, source: &str) -> usize {
        let mut least = usize::MAX;
        for streaming in [true, false] {
            let parser = with(parser(streaming));
            let whole = parse_whole(&parser, source);
            for step in [1, 2, 3, 5, 8, 13, 40, 100] {
                let mut incremental = Incremental::default();
                let read = incremental.parse_in_steps(&parser, &shared(source), step);
                assert_eq!(
                    read.document(),
                    whole,
                    "in steps of {step}, streaming {streaming}: {source:?}"
                );
                least = least.min(incremental.boundary());
            }
        }
        least
    }

    #[test]
    fn long_texts_read_in_steps() {
        for source in [
            HEADINGS,
            LISTS,
            QUOTES,
            TABLES,
            CODE,
            MATH,
            HTML,
            CJK,
            INLINE,
            DEFINITIONS,
            FOOTNOTES,
        ] {
            steps(&format!("{source}\n{source}\n{source}"));
        }
        // Read in parts: the boundary is at the last paragraph's list.
        let typical = format!("{TYPICAL}\n\n{TYPICAL}\n\n{TYPICAL}\n");
        assert_eq!(steps(&typical), typical.rfind("1. first").unwrap());
        // Steps that end inside a character go on to the end of its line.
        let cjk = format!("{CJK}\n{CJK}\n{CJK}");
        assert_eq!(steps(&cjk), cjk.rfind("## 标题").unwrap());
        // A definition anywhere has the text read whole, in one parse.
        assert_eq!(steps(&format!("{TYPICAL}\n\n{DEFINITIONS}")), 0);
    }

    /// A long text is never parsed whole: one parse grows faster than the
    /// text does, so each parse reads about a [`STEP`] of it.
    #[test]
    fn long_texts_are_parsed_a_part_at_a_time() {
        use super::super::LONGEST_PARSE;
        for (name, source) in [("sections", sections(8 * STEP)), ("reply", reply(8 * STEP))] {
            for parser in [
                parser(false),
                parser(true),
                parser(false).plugin(Where),
                parser(true).plugin(Where),
            ] {
                LONGEST_PARSE.with(|longest| longest.set(0));
                let document = super::super::parse(&parser, &source);
                let longest = LONGEST_PARSE.with(|longest| longest.get());
                assert!(
                    longest <= 4 * STEP,
                    "{name}: one parse read {longest} of {} bytes",
                    source.len()
                );
                assert_eq!(document, parse_whole(&parser, &source), "{name}");
            }
        }
    }

    /// A text past twice the step is read in steps by `Parser::markdown`
    /// too; a shorter one, one with a definition and one of a parser that
    /// reads the whole source in one parse.
    #[test]
    fn long_texts_are_read_in_steps_when_they_can_be() {
        // A read ends after a line after a blank line.
        assert_eq!(after_blank("a\nb\n\nc\nd\n", 0), Some(7));
        assert_eq!(after_blank("a\nb\n \t\nc\nd\n", 3), Some(9));
        assert_eq!(after_blank("a\nb\nc\n", 0), None);
        assert_eq!(after_blank("a\n\nc", 0), None);
        let parser = parser(false);
        let typical = TYPICAL.repeat(4);
        let step = typical.len() / 3;
        assert_eq!(
            parse_long_in_steps(&parser, &typical, step),
            Some(parse_whole(&parser, &typical))
        );
        assert_eq!(parse_long_in_steps(&parser, TYPICAL, step), None);
        let with = parser
            .clone()
            .extension(MarkdownExtension::container("note", "note"));
        assert_eq!(parse_long_in_steps(&with, &typical, step), None);
        // A long document of every kind of block, read by `parse` in steps
        // of [`STEP`].
        let mut long = String::new();
        while long.len() < 4 * STEP {
            for source in [HEADINGS, LISTS, QUOTES, TABLES, MATH, HTML, CJK, TYPICAL] {
                long.push_str(source);
                long.push_str("\n\n");
            }
        }
        for parser in [self::parser(false), self::parser(true)] {
            assert_eq!(
                super::super::parse(&parser, &long),
                parse_whole(&parser, &long)
            );
        }
    }

    /// Random documents of [`FRAGMENTS`] given at once and read in random
    /// steps, as long texts are, and whole: the documents are the same.
    #[test]
    fn random_documents_read_in_steps() {
        use std::panic::{AssertUnwindSafe, catch_unwind};
        let mut rng = Rng(0x2545_F491_4F6C_DD1D);
        let parsers = [
            parser(true),
            parser(false),
            parser(true).plugin(Where),
            parser(false).plugin(Where),
        ];
        let mut moved = 0;
        for _ in 0..800 {
            let parser = &parsers[rng.below(parsers.len())];
            let count = 40 + rng.below(200);
            let source: String = (0..count)
                .map(|_| FRAGMENTS[rng.below(FRAGMENTS.len())])
                .collect();
            let step = 1 + rng.below(24);
            // `markdown-rs` panics on a few inputs (see `random`).
            let Ok(whole) = catch_unwind(AssertUnwindSafe(|| parse_whole(parser, &source))) else {
                continue;
            };
            let mut incremental = Incremental::default();
            let read = catch_unwind(AssertUnwindSafe(|| {
                incremental
                    .parse_in_steps(parser, &shared(&source), step)
                    .document()
            }));
            assert_eq!(
                read.ok().as_ref(),
                Some(&whole),
                "in steps of {step}, {:?}: {source:?}",
                parser.options
            );
            moved += usize::from(incremental.boundary() > 0);
        }
        assert!(moved > 100, "the boundary moved in {moved} documents");
    }

    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// Pieces of Markdown, of blocks and of the syntax inside them: put
    /// together at random they make documents no one would write, which is
    /// the point.
    const FRAGMENTS: &[&str] = &[
        "\n",
        "\n",
        "\n\n",
        "\n\n",
        "\n\n",
        " ",
        " ",
        "  \n",
        "    ",
        "\t",
        "word",
        "text here",
        "a",
        "中文",
        "标题：",
        "。",
        "é",
        "# ",
        "## ",
        "# Title\n",
        "## Title\n",
        "#",
        "===\n",
        "---\n",
        "---",
        "***\n",
        "- ",
        "- item\n",
        "* ",
        "+ item\n",
        "1. ",
        "2) ",
        "10. item\n",
        "- [ ] ",
        "- [x] task\n",
        "  - nested\n",
        "   continued\n",
        "> ",
        "> quote\n",
        ">\n",
        "> [!NOTE]\n",
        "> > ",
        "```\n",
        "```rust\n",
        "```",
        "~~~\n",
        "````\n",
        "``",
        "`",
        "`code`",
        "$$\n",
        "$$",
        "$",
        "$x$",
        "$5",
        "\\(",
        "\\)",
        "\\[",
        "\\]",
        "\\[\n",
        "\\]\n",
        "\\[1\\]",
        "| a | b |\n",
        "|---|---|\n",
        "| 1 | 2 |\n",
        "|",
        "| --",
        "a | b\n",
        ":-:|",
        "**",
        "*",
        "__",
        "_",
        "~~",
        "**bold**",
        "*em*",
        "[",
        "]",
        "(",
        ")",
        "[link](https://a.dev)",
        "[ref]",
        "[ref][id]",
        "![img](a.png)",
        "![",
        "](",
        "https://example.com",
        "www.a.dev。",
        "<",
        ">",
        "<b>",
        "</b>",
        "<div>\n",
        "</div>\n",
        "<details>\n",
        "</details>\n",
        "<summary>s</summary>\n",
        "<!-- ",
        " -->",
        "<pre>\n",
        "</pre>\n",
        "<br>",
        "<US tech>",
        "&amp;",
        "\\",
        "\\*",
        "[id]: https://a.dev\n",
        "[id]: ",
        "[^n]",
        "[^n]: note\n",
        "    code\n",
        "Setext\n",
        "=",
        "-",
        "+",
        "1",
        ".",
        ":",
        "!",
        "\r\n",
        "@ada",
    ];

    /// Random documents of [`FRAGMENTS`] arriving in random steps, read
    /// both ways after every step. Returns how many reads there were, how
    /// many documents moved the boundary and how many the parser cannot
    /// read.
    fn random(seed: u64, documents: usize) -> (usize, usize, usize) {
        use std::panic::{AssertUnwindSafe, catch_unwind};
        let mut rng = Rng(seed);
        let parsers = [
            parser(true),
            parser(true),
            parser(false),
            Parser::new().options(MarkdownOptions {
                streaming: true,
                math: false,
                html: false,
                alerts: false,
                frontmatter: true,
                ..MarkdownOptions::default()
            }),
            parser(true).extension(MarkdownExtension::pattern("mention", r"@(\w+)")),
        ];
        let (mut reads, mut moved, mut panicked) = (0, 0, 0);
        for _ in 0..documents {
            let parser = &parsers[rng.below(parsers.len())];
            let count = 4 + rng.below(60);
            let source: String = (0..count)
                .map(|_| FRAGMENTS[rng.below(FRAGMENTS.len())])
                .collect();
            let longest = 1 + rng.below(16);
            let mut incremental = Incremental::default();
            let mut advanced = false;
            let mut end = 0;
            while end < source.len() {
                end = (end + 1 + rng.below(longest)).min(source.len());
                while !source.is_char_boundary(end) {
                    end += 1;
                }
                let text = &source[..end];
                // `markdown-rs` panics on a few inputs (an unwrap in its
                // tree builder): a text it cannot read whole says nothing
                // about reading it in parts, and the text after it is
                // another document.
                let Ok(whole) = catch_unwind(AssertUnwindSafe(|| parser.markdown(text))) else {
                    panicked += 1;
                    break;
                };
                let read = catch_unwind(AssertUnwindSafe(|| {
                    incremental.parse(parser, &shared(text)).document()
                }));
                assert_eq!(
                    read.ok().as_ref(),
                    Some(&whole),
                    "seed {seed}, {:?}: {text:?} of {source:?}",
                    parser.options
                );
                reads += 1;
                // A later definition may discard a boundary reached earlier.
                advanced |= incremental.boundary() > 0;
            }
            moved += usize::from(advanced);
        }
        (reads, moved, panicked)
    }

    #[test]
    fn random_documents() {
        let (reads, moved, _) = random(0x9E37_79B9_7F4A_7C15, 400);
        assert!(reads > 4000 && moved > 100, "{reads} reads, {moved} moved");
    }

    /// The same over many more documents (`cargo test --release -p nsh-base
    /// random_documents_at_length -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn random_documents_at_length() {
        // The parser's own panics are expected here: not printed.
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let mut failed = None;
        for seed in 1..=16u64 {
            let run = std::panic::catch_unwind(|| {
                random(seed.wrapping_mul(0x2545_F491_4F6C_DD1D), 20_000)
            });
            match run {
                Ok((reads, moved, panicked)) => println!(
                    "seed {seed}: {reads} reads, the boundary moved in {moved} documents, the \
                     parser panicked on {panicked}"
                ),
                Err(failure) => {
                    // The hook that prints it is off.
                    if let Some(message) = failure.downcast_ref::<String>() {
                        println!("seed {seed}: {message}");
                    }
                    failed = Some(failure);
                    break;
                }
            }
        }
        std::panic::set_hook(hook);
        if let Some(failure) = failed {
            std::panic::resume_unwind(failure);
        }
    }

    fn reply(bytes: usize) -> String {
        let section = "## Section\n\nSome **bold** text with `code`, a [link](https://example.com) and $x^2$.\n\n- item one\n- item two with *emphasis*\n\n```rust\nfn main() { println!(\"hi\"); }\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> A note.\n\n";
        section.repeat(bytes / section.len() + 1)[..bytes].to_owned()
    }

    /// A reply whose code has `]:`, which is no definition.
    fn python(bytes: usize) -> String {
        let section = "## Section\n\nSome **bold** text with `code`, a [link](https://example.com) and $x^2$.\n\n- item one\n- item two with *emphasis*\n\n```python\nfor key in keys:\n    if seen[key]:\n        total += counts[key]\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> A note.\n\n";
        section.repeat(bytes / section.len() + 1)[..bytes].to_owned()
    }

    fn table(rows: usize) -> String {
        let mut text =
            String::from("Here are the fields:\n\n| Name | Type | Notes |\n|---|---|---|\n");
        for n in 0..rows {
            text.push_str(&format!("| `field_{n}` | `Option<u32>` | see `docs` |\n"));
        }
        text
    }

    fn list(items: usize) -> String {
        let mut text = String::from("Intro.\n\n");
        for n in 0..items {
            text.push_str(&format!("- `item_{n}`: calls `foo()` then `bar()`\n"));
        }
        text
    }

    fn program(lines: usize) -> String {
        let mut text = String::from("Here is the program:\n\n```rust\n");
        for n in 0..lines {
            text.push_str(&format!(
                "    let value_{n} = compute(&items[{n}], Some(\"x\"))?;\n"
            ));
        }
        text.push_str("```\n");
        text
    }

    /// The time of a stream's updates: all of them, and the last ten.
    #[derive(Default)]
    struct Updates {
        total: f64,
        last: Vec<f64>,
    }

    impl Updates {
        fn add(&mut self, start: std::time::Instant) {
            let ms = start.elapsed().as_secs_f64() * 1000.0;
            self.total += ms;
            self.last.push(ms);
            if self.last.len() > 10 {
                self.last.remove(0);
            }
        }

        fn cell(&self) -> String {
            let last = self.last.iter().sum::<f64>() / self.last.len().max(1) as f64;
            format!("{:>8.1} / {:>6.3}", self.total, last)
        }
    }

    /// A fresh set or one update after an untimed set. Alternate the two
    /// readers, and keep document comparison and destruction out of timing.
    fn bench_set(parser: &Parser, before: Option<&str>, source: &str) -> [f64; 2] {
        use std::{hint::black_box, time::Instant};
        let source = shared(source);
        let before = before.map(shared);
        let prepare = || {
            let mut incremental = Incremental::default();
            if let Some(before) = &before {
                black_box(incremental.parse(parser, before));
            }
            incremental
        };
        assert_eq!(
            prepare().parse(parser, &source).document(),
            parser.markdown(&source)
        );
        let mut ms = [0.0; 2];
        for run in 0..30 {
            let mut incremental = prepare();
            for reader in [run % 2, 1 - run % 2] {
                let start = Instant::now();
                if reader == 0 {
                    let read = black_box(parser.markdown(black_box(&source)));
                    ms[reader] += start.elapsed().as_secs_f64() * 1000.0;
                    drop(read);
                } else {
                    let read = black_box(incremental.parse(parser, black_box(&source)));
                    ms[reader] += start.elapsed().as_secs_f64() * 1000.0;
                    drop(read);
                }
            }
        }
        ms.map(|ms| ms / 30.0)
    }

    /// `cargo test --release -p nsh-base --lib bench_streaming_set -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_streaming_set() {
        let mut body = reply(40_000);
        // End at a complete section: a truncated fence would hide the
        // definitions from both readers and measure the wrong case.
        body.truncate(body.rfind("\n\n## Section\n").unwrap());
        body.push_str("\n\nSee [docs] and note[^a].\n\nBefore definitions.\n\n");
        println!("mean ms of 30 runs; setup, comparison and drop excluded");
        println!(
            "{:<15} {:<16} {:>9} {:>7} | {:>11} | {:>11}",
            "definitions", "update", "streaming", "bytes", "whole", "kept"
        );
        for streaming in [false, true] {
            let parser = parser(streaming);
            for (name, definitions) in [
                ("none", ""),
                ("literal markers", "`[docs]: /guide` and `[^a]: note`"),
                ("link", "[docs]: https://example.com/guide"),
                ("footnote", "[^a]: A note"),
                (
                    "link + footnote",
                    "[docs]: https://example.com/guide\n\n[^a]: A note",
                ),
            ] {
                let source = format!("{body}{definitions}");
                let replaced = format!("# Previous\n\n{source}");
                let continued = format!("{source}/more");
                for (update, before, text) in [
                    ("first set", None, source.as_str()),
                    ("replace", Some(replaced.as_str()), source.as_str()),
                    ("late definition", Some(body.as_str()), source.as_str()),
                    ("tail grows", Some(source.as_str()), continued.as_str()),
                ] {
                    if definitions.is_empty() && matches!(update, "late definition" | "tail grows")
                    {
                        continue;
                    }
                    let [whole, kept] = bench_set(&parser, before, text);
                    println!(
                        "{name:<15} {update:<16} {streaming:>9} {:>7} | {whole:>11.3} | {kept:>11.3}",
                        text.len()
                    );
                }
            }
            // The first late definition can follow a large tail that
            // cannot be split: the tail is not read before the whole text.
            let before = format!("{body}{}", "> A quoted paragraph.\n>\n".repeat(1600));
            let source = format!("{before}> [docs]: /guide");
            let [whole, kept] = bench_set(&parser, Some(&before), &source);
            println!(
                "{:<15} {:<16} {streaming:>9} {:>7} | {whole:>11.3} | {kept:>11.3}",
                "link in quote",
                "late definition",
                source.len()
            );
        }
    }

    /// What a `TextView` does with its Markdown on each update of a reply
    /// arriving 24 bytes at a time, up to the rows: reading the text, then
    /// the document's and the blocks' memos (their value made and compared
    /// with the one before). `whole` is what it did before it kept what it
    /// read: every update parses the whole text, copies its blocks and
    /// compares them all.
    ///
    /// `cargo test --release -p nsh-base bench_streaming -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_streaming() {
        use std::{hint::black_box, time::Instant};
        let parser = parser(true);
        println!("total ms over the stream / average ms of the last 10 updates");
        println!(
            "{:<26} {:>7} | {:>17} | {:>17} | {:>17} | {:>17}",
            "reply", "updates", "whole: parse", "whole: all", "kept: parse", "kept: all"
        );
        for (name, source) in [
            ("typical, 20 KB", reply(20_000)),
            ("typical, 40 KB", reply(40_000)),
            ("`]:` in its code, 20 KB", python(20_000)),
            ("`]:` in its code, 40 KB", python(40_000)),
            ("ends in a 400-row table", table(400)),
            ("ends in a 400-item list", list(400)),
            ("ends in 400 lines of code", program(400)),
        ] {
            let mut cuts: Vec<usize> = (24..source.len()).step_by(24).collect();
            cuts.push(source.len());
            let mut whole_parse = Updates::default();
            let mut whole = Updates::default();
            let mut document = Document::default();
            let mut blocks: Vec<(usize, Block)> = Vec::new();
            for &cut in &cuts {
                let text = &source[..cut];
                let start = Instant::now();
                let read = parser.markdown(text);
                whole_parse.add(start);
                black_box(read == document);
                let rows: Vec<(usize, Block)> = read.blocks.iter().cloned().enumerate().collect();
                black_box(rows == blocks);
                whole.add(start);
                document = read;
                blocks = rows;
            }
            let mut kept_parse = Updates::default();
            let mut kept = Updates::default();
            let mut incremental = Incremental::default();
            let mut document = Parsed::default();
            let mut blocks: Vec<(usize, SharedBlock)> = Vec::new();
            for &cut in &cuts {
                // The view is given a string that is shared already.
                let text = shared(&source[..cut]);
                let start = Instant::now();
                let read = incremental.parse(&parser, &text);
                kept_parse.add(start);
                black_box(read == document);
                let rows: Vec<(usize, SharedBlock)> =
                    read.blocks.iter().cloned().enumerate().collect();
                black_box(rows == blocks);
                kept.add(start);
                document = read;
                blocks = rows;
            }
            assert_eq!(document.document(), parser.markdown(&source));
            println!(
                "{name:<26} {:>7} | {} | {} | {} | {}",
                cuts.len(),
                whole_parse.cell(),
                whole.cell(),
                kept_parse.cell(),
                kept.cell()
            );
        }
    }

    /// Sections of a heading, a paragraph with bold words and a link, and
    /// a list of two items, about 50 bytes a block.
    fn sections(bytes: usize) -> String {
        let mut text = String::with_capacity(bytes + 200);
        let mut n = 0;
        while text.len() < bytes {
            n += 1;
            text.push_str(&format!(
                "## Section {n}\n\nSome **bold** text and a [link](https://example.com/{n}), with a few more words in each paragraph.\n\n- the first item of the list\n- the second item\n\n"
            ));
        }
        text
    }

    /// `cargo test --release -p nsh-base --lib bench_long_texts -- --ignored
    /// --nocapture`: a long text given at once, read in one parse and in
    /// steps (`Parser::markdown`), ms, the minimum of three; without a
    /// plugin and with one that reads paragraphs, headings, code, formulas
    /// and tables ([`Where`]). The numbers are in `docs/dev/performance.md`.
    #[test]
    #[ignore]
    fn bench_long_texts() {
        use std::time::Instant;
        let bare = Parser::new();
        let plugged = Parser::new().plugin(Where);
        println!("ms to read, in one parse / in steps: without a plugin | with one");
        let mut cases: Vec<(String, String)> = [190, 475, 950, 1_900]
            .into_iter()
            .map(|kb| (format!("sections, {kb} KB"), sections(kb * 1_000)))
            .collect();
        cases.extend([
            ("typical reply, 950 KB".to_owned(), reply(950_000)),
            ("typical reply, 1,900 KB".to_owned(), reply(1_900_000)),
            ("one table, 20,000 rows".to_owned(), table(20_000)),
            ("one list, 20,000 items".to_owned(), list(20_000)),
            ("one code block, 20,000 lines".to_owned(), program(20_000)),
        ]);
        for (name, source) in cases {
            let time = |read: &dyn Fn() -> Document| {
                (0..3)
                    .map(|_| {
                        let start = Instant::now();
                        let document = read();
                        let ms = start.elapsed().as_secs_f64() * 1000.0;
                        drop(document);
                        ms
                    })
                    .fold(f64::MAX, f64::min)
            };
            let mut cells = Vec::new();
            for parser in [&bare, &plugged] {
                let whole = time(&|| parse_whole(parser, &source));
                let steps = time(&|| super::super::parse(parser, &source));
                assert_eq!(
                    super::super::parse(parser, &source),
                    parse_whole(parser, &source)
                );
                cells.push(format!("{whole:>9.1} / {steps:>9.1}"));
            }
            println!(
                "{name:<30} {:>5} KB | {} | {}",
                source.len() / 1000,
                cells[0],
                cells[1]
            );
        }
    }
}
