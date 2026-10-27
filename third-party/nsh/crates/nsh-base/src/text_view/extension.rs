//! What reads a document: the Markdown and HTML parsers, their options and
//! extensions, declared ([`MarkdownExtension`], from TS too) or written in
//! Rust ([`MarkdownPlugin`]).

use std::{fmt, sync::Arc};

/// Re-export of the Markdown syntax tree plugins read (`markdown-rs`'s).
pub use markdown::mdast;
use nsh_core::prelude::*;

use super::document::{Block, CustomNode, Document, Inline};

/// A Markdown extension: syntax that becomes a custom node
/// (a `TextViewCustomNode`) named `name`, which the app's `renderCustom`
/// shows. Give it one of `pattern`, `language`, `tag` or `container`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct MarkdownExtension {
    /// The name of the nodes it makes.
    pub name: SharedString,
    /// Inline syntax: a regular expression (Rust's `regex` syntax) matched
    /// in text, outside code and links (`"@(\\w+)"` for mentions). Each
    /// match is an inline node: its `text` the match, its numbered groups
    /// the attributes `"1"`, `"2"`, ..., its named groups by name.
    pub pattern: Option<SharedString>,
    /// Fenced code blocks of this language (```` ```chart ````) are block
    /// nodes: their `text` the code, the rest of the info string the
    /// attribute `meta`.
    pub language: Option<SharedString>,
    /// HTML and MDX elements of this tag (`"callout"`, any case:
    /// `<Callout kind="tip">…</Callout>`) are nodes: their attributes, their
    /// content parsed (blocks for an element of its own line, inline
    /// content inside text).
    pub tag: Option<SharedString>,
    /// Containers of this name (`:::note` … `:::`, as `remark-directive`
    /// writes them) are block nodes of the Markdown inside: the label
    /// after the name (`:::note[Heads up]`) is the attribute `label`,
    /// `{key=value}` (or `{.class #id}`) the other attributes.
    pub container: Option<SharedString>,
}

impl MarkdownExtension {
    /// Inline nodes `name` where `pattern` matches.
    pub fn pattern(name: impl Into<SharedString>, pattern: impl Into<SharedString>) -> Self {
        Self {
            name: name.into(),
            pattern: Some(pattern.into()),
            ..Self::default()
        }
    }

    /// Block nodes `name` for fenced code of `language`.
    pub fn language(name: impl Into<SharedString>, language: impl Into<SharedString>) -> Self {
        Self {
            name: name.into(),
            language: Some(language.into()),
            ..Self::default()
        }
    }

    /// Nodes `name` for elements `<tag>`.
    pub fn tag(name: impl Into<SharedString>, tag: impl Into<SharedString>) -> Self {
        Self {
            name: name.into(),
            tag: Some(tag.into()),
            ..Self::default()
        }
    }

    /// Block nodes `name` for containers `:::container`.
    pub fn container(name: impl Into<SharedString>, container: impl Into<SharedString>) -> Self {
        Self {
            name: name.into(),
            container: Some(container.into()),
            ..Self::default()
        }
    }
}

/// What Markdown syntax a document is read with, beyond CommonMark and
/// GitHub's (tables, task lists, strikethrough, autolinks, footnotes:
/// always).
#[derive(Debug, Clone, Copy, PartialEq, JsObject)]
pub struct MarkdownOptions {
    /// Formulas: `$…$` in text, `$$…$$` blocks (default true).
    #[prop(default = true)]
    pub math: bool,
    /// HTML in the Markdown is read as `TextView`'s `html` is
    /// (default true); false shows it as text.
    #[prop(default = true)]
    pub html: bool,
    /// GitHub's alerts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
    /// `[!WARNING]`, `[!CAUTION]` (default true).
    #[prop(default = true)]
    pub alerts: bool,
    /// YAML front matter (`---` … `---` first) is a custom node
    /// `frontmatter` whose text is the YAML (default false: a rule and
    /// text).
    #[prop(default)]
    pub frontmatter: bool,
    /// MDX: JSX elements and `{expressions}` (default false). Elements are
    /// custom nodes named by their tag (their attributes, their content),
    /// expressions custom nodes `expression` (their text); raw HTML is
    /// then not read.
    #[prop(default)]
    pub mdx: bool,
    /// Keep single line breaks in paragraphs instead of flowing them as
    /// spaces (default false). Useful for messages with intentional lines.
    #[prop(default)]
    pub preserve_line_breaks: bool,
    /// The text is still arriving (a reply streamed by an AI model):
    /// syntax its end leaves open (`**bold`, `` `code ``, `[link](`, a
    /// table's header alone) is shown as if it were closed, not as
    /// literal characters until the rest arrives (default false).
    #[prop(default)]
    pub streaming: bool,
}

impl Default for MarkdownOptions {
    fn default() -> Self {
        Self {
            math: true,
            html: true,
            alerts: true,
            frontmatter: false,
            mdx: false,
            streaming: false,
            preserve_line_breaks: false,
        }
    }
}

/// A Markdown extension written in Rust: it reads nodes of the syntax tree
/// (`markdown-rs`'s [`mdast`]) as blocks or inline content of its own,
/// usually [`CustomNode`]s, and may show them.
///
/// The parser offers it each node before reading the node itself (blocks
/// to [`Self::block`], inline nodes to [`Self::inline`]); the first plugin
/// that returns `Some` wins. Give a view's plugins with
/// [`MarkdownPlugins`] (`provide_context`): every [`super::TextView`]
/// below it reads with them. Parsing hooks run on the CPU worker and must
/// be `Send + Sync`; `render` runs on the component's UI owner.
pub trait MarkdownPlugin: Send + Sync + 'static {
    /// Its name (for logs).
    fn name(&self) -> &str;

    /// Turns on the syntax it reads (`markdown-rs`'s constructs).
    fn configure(&self, options: &mut markdown::ParseOptions) {
        let _ = options;
    }

    /// Node `node` (a block: a paragraph, code, a container, ...) read as
    /// a block of its own, or `None` to leave it to the parser.
    fn block(&self, node: &mdast::Node, cx: &mut ParseContext<'_>) -> Option<Block> {
        let _ = (node, cx);
        None
    }

    /// Node `node` (inside a paragraph, a heading, a cell) read as inline
    /// content of its own, or `None` to leave it to the parser.
    fn inline(&self, node: &mdast::Node, cx: &mut ParseContext<'_>) -> Option<Inline> {
        let _ = (node, cx);
        None
    }

    /// Custom node `node` shown, or `None` to leave it to the app's
    /// `renderCustom` (else its content).
    fn render(&self, node: &CustomNode) -> Option<AnyElement> {
        let _ = node;
        None
    }
}

/// What a [`MarkdownPlugin`] reads with: the source and the parser, for the
/// node's children.
pub struct ParseContext<'a> {
    pub(crate) source: &'a str,
    pub(crate) reader: &'a mut dyn ReadChildren,
}

/// The parser's side of a [`ParseContext`].
pub(crate) trait ReadChildren {
    fn blocks(&mut self, source: &str, nodes: &[mdast::Node]) -> Vec<Block>;
    fn inlines(&mut self, source: &str, nodes: &[mdast::Node]) -> Vec<Inline>;
}

impl<'a> ParseContext<'a> {
    /// The Markdown being read.
    pub fn source(&self) -> &'a str {
        self.source
    }

    /// The source of node `node` (with its syntax).
    pub fn node_source(&self, node: &mdast::Node) -> Option<&'a str> {
        let position = node.position()?;
        self.source.get(position.start.offset..position.end.offset)
    }

    /// Block nodes `nodes` read as the parser reads them.
    pub fn blocks(&mut self, nodes: &[mdast::Node]) -> Vec<Block> {
        self.reader.blocks(self.source, nodes)
    }

    /// Inline nodes `nodes` read as the parser reads them.
    pub fn inlines(&mut self, nodes: &[mdast::Node]) -> Vec<Inline> {
        self.reader.inlines(self.source, nodes)
    }
}

/// The [`MarkdownPlugin`]s [`super::TextView`]s read with, given by a view
/// to those below it: `provide_context(MarkdownPlugins::new().with(Mentions))`.
#[derive(Clone, Default)]
pub struct MarkdownPlugins(pub(crate) Vec<Arc<dyn MarkdownPlugin>>);

impl MarkdownPlugins {
    /// None.
    pub fn new() -> Self {
        Self::default()
    }

    /// With `plugin` after the others.
    pub fn with(mut self, plugin: impl MarkdownPlugin) -> Self {
        self.0.push(Arc::new(plugin));
        self
    }

    /// Whether there are none.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Custom node `node` shown by the first plugin that shows it.
    pub(crate) fn render(&self, node: &CustomNode) -> Option<AnyElement> {
        self.0.iter().find_map(|p| p.render(node))
    }
}

impl fmt::Debug for MarkdownPlugins {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list()
            .entries(self.0.iter().map(|p| p.name()))
            .finish()
    }
}

impl PartialEq for MarkdownPlugins {
    fn eq(&self, other: &Self) -> bool {
        self.0.len() == other.0.len() && self.0.iter().zip(&other.0).all(|(a, b)| Arc::ptr_eq(a, b))
    }
}

/// Reads Markdown and HTML into [`Document`]s, with options, declared
/// extensions and plugins.
#[derive(Debug, Clone, Default)]
pub struct Parser {
    pub(crate) options: MarkdownOptions,
    pub(crate) extensions: Vec<MarkdownExtension>,
    pub(crate) plugins: MarkdownPlugins,
}

impl Parser {
    /// A parser of CommonMark and GitHub's Markdown with the default
    /// [`MarkdownOptions`].
    pub fn new() -> Self {
        Self::default()
    }

    /// With options `options`.
    pub fn options(mut self, options: MarkdownOptions) -> Self {
        self.options = options;
        self
    }

    /// With extension `extension` after the others.
    pub fn extension(mut self, extension: MarkdownExtension) -> Self {
        self.extensions.push(extension);
        self
    }

    /// With extensions `extensions` after the others.
    pub fn extensions(mut self, extensions: impl IntoIterator<Item = MarkdownExtension>) -> Self {
        self.extensions.extend(extensions);
        self
    }

    /// With plugins `plugins` after the others.
    pub fn plugins(mut self, plugins: &MarkdownPlugins) -> Self {
        self.plugins.0.extend(plugins.0.iter().cloned());
        self
    }

    /// With plugin `plugin` after the others.
    pub fn plugin(mut self, plugin: impl MarkdownPlugin) -> Self {
        self.plugins.0.push(Arc::new(plugin));
        self
    }

    /// Markdown `source` read.
    pub fn markdown(&self, source: &str) -> Document {
        super::markdown::parse(self, source, false).document
    }

    /// Markdown with canonical UTF-8 provenance for a rendered document.
    /// This uses the same parser and converter as `markdown`.
    pub(super) fn markdown_projection(&self, source: &str) -> super::markdown::Projection {
        super::markdown::parse(self, source, true)
    }

    /// HTML `source` read (a fragment or a whole page: its body).
    pub fn html(&self, source: &str) -> Document {
        super::html::parse(self, source)
    }
}
