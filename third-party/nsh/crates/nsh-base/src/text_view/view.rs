//! The `TextView` component: a [`Document`] shown with the primitives.

use std::{
    cell::RefCell,
    collections::HashMap,
    rc::{Rc, Weak},
    sync::Arc,
};

use nsh_core::{
    ListContentStyle, ListSourceRows, ListViewport, ResizeMode,
    color::Hsla,
    element::{
        Arg, CallCx, Instance, JsHost, JsIn, JsOwned, JsValue, Owner, PropError, Renderer, Ret,
        Style, StyleRefinement, TsTypes,
    },
    geometry::{DefiniteLength, Length},
    prelude::*,
};

use super::{
    Alert, Block, CodeBlock, ColumnAlign, CustomNode, Document, Image, ImageLength, Inline,
    ListItem, MarkdownExtension, MarkdownOptions, MarkdownPlugins, Parser, Table,
    markdown::{Projection, ProjectionKind},
    parse::{DocumentState, SourceOrigin},
    parts::{TextViewClasses, TextViewPart as Part, TextViewParts, TextViewStyles},
};
use crate::theme::theme;

/// The props of [`TextView`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct TextViewProps {
    /// The document as Markdown (CommonMark and GitHub's: tables, task
    /// lists, footnotes, alerts; formulas; HTML inside). A reply streamed
    /// by an AI model can be passed as it grows (with `options={{
    /// streaming: true }}`): only the blocks that changed are shown again.
    pub markdown: Prop<Option<SharedString>>,
    /// Stable identity of the original UTF-8 source for reading anchors.
    pub source_id: Prop<Option<SharedString>>,
    /// Accessible labels and feedback supplied by the app.
    #[prop(default)]
    pub labels: Prop<TextViewLabels>,
    /// The document as HTML (simple markup as a reader shows it: no CSS or
    /// scripts), when `markdown` is not given.
    pub html: Prop<Option<SharedString>>,
    /// The document as blocks the app made, when neither `markdown` nor
    /// `html` is given.
    pub document: Prop<Option<Document>>,
    /// The Markdown syntax read beyond CommonMark and GitHub's.
    #[prop(default)]
    pub options: Prop<MarkdownOptions>,
    /// Syntax of the app's that becomes custom nodes, shown by
    /// `renderCustom` (mentions, charts, callouts, ...).
    #[prop(default)]
    pub extensions: Prop<Vec<MarkdownExtension>>,
    /// Tailwind classes by part (`{ heading1: "text-2xl font-bold", code:
    /// "font-mono bg-muted" }`), after the part's own styles.
    #[prop(default)]
    pub classes: Prop<TextViewClasses>,
    /// Inline styles by part, over their classes.
    #[prop(default)]
    pub styles: Prop<TextViewStyles>,
    /// Padding and spacing of the native document rows, in points.
    /// Supplying a value replaces the complete content layout.
    #[prop(default = default_content_style())]
    pub content_style: Prop<ListContentStyle>,
    /// Its mounted texts share one selection for copying (a long press,
    /// or a drag with a pointer), joined by a surrounding selectable View.
    #[prop(default)]
    pub selectable: Prop<bool>,
    /// What a press on a link does: `"report"` (the default) reports it
    /// (`onLinkPress`) and opens nothing; `"open"` also opens a link to
    /// another app or site outside the app (`openUrl` of `nsh/device`,
    /// under the app's `openUrl` capability; the embedding app may route
    /// it), while anchors in the document (`#…`) are only reported.
    #[prop(default)]
    pub links: Prop<TextViewLinks>,
    /// Whether code blocks show the scroll indicator of their horizontal
    /// scroll view (default true).
    #[prop(default = true)]
    pub code_block_scrollbar: Prop<bool>,
    /// Whether tables show the scroll indicator of their horizontal scroll
    /// view (default true).
    #[prop(default = true)]
    pub table_scrollbar: Prop<bool>,
    /// Shown inline at the end of the last block (a streaming reply's
    /// caret).
    pub streaming_caret: Prop<Option<Slot>>,
    /// Shows a custom node (an extension's or the document's): `node.name`
    /// tells which. Without it, a custom node shows its content.
    pub render_custom: Prop<Option<Renderer<CustomNode>>>,
    /// Shows a code block in place of the default (the code in a
    /// horizontal scroll view): syntax highlighting of the app's.
    pub render_code_block: Prop<Option<Renderer<CodeBlock>>>,
    /// Content of the app's floating over each code block's top right
    /// The icon of a code block's action of the app's (`codeBlockActions`):
    /// the button around it (its size, hover and press backgrounds) is the
    /// text view's, so every action looks alike. Without it, an action
    /// shows its label.
    pub render_code_block_action: Prop<Option<Renderer<TextViewCodeAction>>>,
    /// The buttons over each code block's top right corner, in order:
    /// `{ id: "copy" }` is built in (it copies the code and shows a check
    /// for a moment), other ids are the app's (their icon from
    /// `renderCodeBlockAction`, a press reported by `onCodeBlockAction`).
    /// All are ghost buttons that show while a pointer hovers the block on
    /// desktops, always on touch screens.
    #[prop(default)]
    pub code_block_actions: Prop<Vec<TextViewCodeAction>>,
    /// Content of the app's above each table (a copy or export button).
    pub render_table_actions: Prop<Option<Renderer<Table>>>,
    /// Shows a formula (`$…$` in text, `$$…$$` blocks); without it, its
    /// TeX shows as code.
    pub render_math: Prop<Option<Renderer<TextViewMath>>>,
    /// Shows an image in place of the default: alone in a paragraph, the
    /// image at the size it asks for (`width` / `height`) or its natural
    /// size, at most as wide as the text; in a line of text, the size it
    /// asks for, else three quarters of a line tall. A press on an image in
    /// a link reports the link (`onLinkPress`), on another the image
    /// (`onImagePress`).
    pub render_image: Prop<Option<Renderer<TextViewImageContext>>>,
}

/// Localized labels for native document controls.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct TextViewLabels {
    /// The table's accessible name.
    pub table: Option<SharedString>,
    /// Feedback after copying a code block.
    pub copied: Option<SharedString>,
}

/// Layout and activation context for an app's image renderer. The app owns
/// standalone image activation; linked images activate their enclosing link.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct TextViewImageContext {
    /// The immutable parsed image.
    pub image: Image,
    /// The image belongs to a link (do not add a competing press target).
    pub linked: bool,
    /// Whether the image stands alone or is an attachment in text.
    pub flow: TextViewImageFlow,
    /// Height of its surrounding text line, in points.
    pub line_height: f32,
}

/// How an image participates in the document's text flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum TextViewImageFlow {
    /// An image on its own line.
    Block,
    /// An attachment inside a text line.
    Inline,
}

/// A focus capability bound to the exact originating Link's lifetime.
#[class(interface)]
#[derive(Debug, Clone)]
pub struct TextViewLinkTarget {
    element: ElementRef,
    owner: Owner,
    origin: SourceOrigin,
    lifetime: Weak<()>,
}

impl PartialEq for TextViewLinkTarget {
    fn eq(&self, other: &Self) -> bool {
        self.element == other.element && Weak::ptr_eq(&self.lifetime, &other.lifetime)
    }
}
#[class]
impl TextViewLinkTarget {
    /// Whether the exact original Link still owns this capability.
    pub fn is_live(&self) -> bool {
        self.lifetime.strong_count() != 0
    }

    /// Accept a focus restoration request while the original Link still
    /// lives. It runs natively in order with the caller's earlier UI changes.
    pub fn focus(&self, cx: CallCx<'_>) -> bool {
        if !self.is_live() {
            return false;
        }
        let target = self.clone();
        cx.start(async move {
            target.focus_native();
        });
        true
    }
}
impl TextViewLinkTarget {
    fn focus_native(&self) -> bool {
        if self.lifetime.strong_count() == 0
            || !self.owner.is_live()
            || !self.origin.is_current()
            || self.element.node().is_none()
        {
            return false;
        }
        self.element.focus();
        true
    }
}
/// A formula of a [`TextView`]'s document, for its `renderMath`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct TextViewMath {
    /// The formula, in TeX.
    pub tex: SharedString,
    /// A block of its own (`$$…$$`), not inside text.
    pub display: bool,
}

/// What a press on a link of a [`TextView`] does (`links`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum TextViewLinks {
    /// It is reported (`onLinkPress`); the app decides what opens.
    #[default]
    Report,
    /// It is reported, then a URL of another app or site (with a scheme:
    /// `https:`, `mailto:`, ...) opens outside the app
    /// ([`nsh_core::element::open_url`]); an anchor in the document (`#…`) is
    /// only reported.
    Open,
}

/// The events of a [`TextView`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TextViewEvent {
    /// A link was pressed: its URL (`#anchor` for a heading of the
    /// document, `#footnote-<label>` for a footnote). Nothing opens it
    /// unless `links` is `"open"`: the app decides.
    #[args(event)]
    LinkPress(TextViewLinkPressEvent),
    /// An image that is not in a link was pressed: the image (its `src`,
    /// `alt`, `title`, size), for the app to show it larger (a zoomable
    /// viewer of its own).
    #[args(image)]
    ImagePress(Image),
    /// An action of a code block was pressed (after the built-in `copy`
    /// copied): its id and the code block.
    #[args(event)]
    CodeBlockAction(TextViewCodeActionEvent),
    /// User scrolling in a code block or table.
    ScrollIntent,
    /// Native formatting failed; the complete original text remains visible.
    #[args(reason)]
    ParseError(Option<SharedString>),
}

/// An action of the code blocks of a [`TextView`] (`codeBlockActions`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct TextViewCodeAction {
    /// Which it is: `"copy"` (built in: copies the code, then shows a check
    /// for a moment), or an id of the app's.
    pub id: SharedString,
    /// What screen readers say for it (default: its id).
    pub label: Option<SharedString>,
}

impl TextViewCodeAction {
    /// Action `id`.
    pub fn new(id: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: None,
        }
    }

    /// With label `label` for screen readers.
    pub fn with_label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }
}

/// A press on a link of a [`TextView`] (`onLinkPress`).
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct TextViewLinkPressEvent {
    /// The link's URL (`#anchor` for a heading of the document,
    /// `#footnote-<label>` for a footnote).
    pub url: SharedString,
    /// Exact original native Link; its capability expires with that Link.
    pub target: Option<TextViewLinkTarget>,
}

// Classes cross through Arg/Ret, rather than JsValue's blanket Ret. Keep
// this event's conversion at that boundary and derive its target declaration
// from the actual class spec registered by nsh/base.
impl JsValue for TextViewLinkPressEvent {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("TextViewLinkPressEvent", |types| {
            let url = <SharedString as JsValue>::ts_type(types);
            let target = <Option<Instance<TextViewLinkTarget>> as Arg>::ts_type(types);
            format!("/** A native document link press and its original focus capability. */\nexport interface TextViewLinkPressEvent {{\n  url: {url};\n  target: {target};\n}}")
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let url = <SharedString as JsValue>::from_js(value.field("url")?.get())?;
        let target =
            <Option<Instance<TextViewLinkTarget>> as Arg>::from_js(value.field("target")?.get())?
                .map(|target| target.with(Clone::clone));
        Ok(Self { url, target })
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let object = JsOwned::new(host, host.new_object()?);
        host.set_field(
            object.get().raw(),
            "url",
            <SharedString as JsValue>::to_js(&self.url, host)?.into_raw(),
        )?;
        let target = match &self.target {
            Some(target) => target.clone().into_js(host)?,
            None => JsOwned::new(host, host.null()),
        };
        host.set_field(object.get().raw(), "target", target.into_raw())?;
        Ok(object)
    }
}

/// A press on a code block's action (`onCodeBlockAction`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct TextViewCodeActionEvent {
    /// The action's id.
    pub id: SharedString,
    /// The code block.
    pub code: CodeBlock,
}

/// A document of Markdown, HTML or the app's own blocks (`markdown`,
/// `html` or `document`), shown with texts, views and images: headings,
/// paragraphs, emphasis, links, lists and task lists, quotes and alerts,
/// code, tables, images, formulas, footnotes and disclosures, and the
/// custom nodes of the app's extensions.
///
/// It has a reading typography of its own (15pt text in 25.5pt lines,
/// semibold headings with room above them, tinted alerts, code in bordered
/// boxes, ruled tables), colored with the theme's tokens, so a theme or the
/// dark appearance reaches it natively. The app restyles each part with
/// `classes` or `styles` (or a Rust view's [`TextViewParts`]), its root
/// with `class` and `style` (text styles there pass to every part): they
/// apply over these defaults. Links report presses
/// (`onLinkPress`). Content of the app's goes in with render functions:
/// custom nodes (`renderCustom`), code blocks and their actions, tables'
/// actions, formulas, images. Made for replies streamed by AI models:
/// blocks are kept by position, so only those that changed are made
/// again, and `streaming_caret` follows the end of the text.
#[component]
pub fn TextView(props: TextViewProps, cx: Scope<TextViewEvent>) -> impl IntoElement {
    let plugins = use_context::<MarkdownPlugins>().unwrap_or_default();
    let parsed = super::parse::document(props, plugins.clone(), cx);
    let document = parsed.document;
    let count =
        computed(move || document.with(|d| d.blocks.len() + usize::from(!d.footnotes.is_empty())));
    let plugins = Rc::new(plugins);
    dynamic(move || {
        parsed.track_source();
        // User choices belong to the source, not to a recycled list cell.
        // Signals and event owners are still made under each logical row.
        let choices = BlockChoices::new(document);
        let prune = choices.clone();
        effect(move || document.with(|document| prune.retain(document)));
        let row_plugins = plugins.clone();
        virtual_list(count, move |at| {
            let rows = computed(move || {
                let index = at.index();
                document.with(|d| {
                    d.blocks
                        .get(index)
                        .cloned()
                        .map(|block| DocumentRow::Block(d.kind, index, Box::new(block)))
                        .or_else(|| {
                            (index == d.blocks.len() && !d.footnotes.is_empty())
                                .then_some(DocumentRow::Footnotes)
                        })
                        .into_iter()
                        .collect::<Vec<_>>()
                })
            });
            let plugins = row_plugins.clone();
            let choices = choices.clone();
            each(rows, DocumentRow::key, move |item, _| {
                let cx = Cx::read(&props, cx, plugins.clone(), parsed, choices.clone());
                // A cell follows Position. This owner instead follows the
                // logical block, so its old callbacks cannot address a row
                // that the cell starts showing later.
                let content = match item.get_untracked() {
                    DocumentRow::Block(_, index, _) => {
                        let last = computed(move || document.with(|d| index + 1 == d.blocks.len()));
                        let before = computed(move || {
                            document.with(|d| {
                                Before::of(index.checked_sub(1).and_then(|i| d.blocks.get(i)))
                            })
                        });
                        let block = computed(move || match item.get() {
                            DocumentRow::Block(_, _, block) => *block,
                            DocumentRow::Footnotes => unreachable!(),
                        });
                        cx.block(block, index.to_string(), last, before)
                    }
                    DocumentRow::Footnotes => {
                        cx.footnotes(computed(move || document.with(|d| d.footnotes.clone())))
                    }
                };
                view().child(content)
            })
        })
        .viewport(ListViewport::Parent)
        .source_rows(move || {
            // The live domain may be longer than this worker publication.
            // Neither the repaired parser input nor an admitted old prefix
            // may claim the current source's complete byte coverage.
            let source = props.markdown.get()?;
            let id = props.source_id.get()?;
            document.with(|projection| {
                let mut rows = ListSourceRows::default();
                rows.id = Arc::from(id.as_str());
                rows.source_len = source.len() as u64;
                rows.projection_len = projection.raw_len;
                rows.rows = projection.rows.clone();
                Some(Arc::new(rows))
            })
        })
        .content_style(props.content_style)
        .flex_col()
        .keys(move || {
            document.with(|d| {
                d.blocks
                    .iter()
                    .enumerate()
                    .map(|(index, block)| DocumentRowKey::block(d.kind, index, block))
                    .chain((!d.footnotes.is_empty()).then_some(DocumentRowKey::Footnotes))
                    .collect::<Vec<_>>()
            })
        })
        .text_size(px(BODY_SIZE))
        .line_height(px(BODY_SIZE * BODY_LINE))
        .text_color(move || theme().foreground)
        // Parent mode contributes these mounted texts to the surrounding
        // reader and selection area; it owns no independent scroll offset.
        .selectable(props.selectable)
        .map(|mut el| {
            if let Some(parts) = use_context::<TextViewParts>() {
                let style = std::mem::take(el.style());
                *el.style() = parts.refine(Part::Root, style);
            }
            el
        })
        .app_class(move || props.classes.with(|c| c.root.clone()))
        .inline_style(move || {
            props
                .styles
                .with(|s| s.root.as_ref().map(|s| s.0.clone()).unwrap_or_default())
        })
    })
}

fn default_content_style() -> ListContentStyle {
    ListContentStyle {
        row_gap: px(BLOCK_GAP),
        ..ListContentStyle::default()
    }
}

#[derive(Clone, PartialEq)]
enum DocumentRow {
    Block(ProjectionKind, usize, Box<Block>),
    Footnotes,
}
#[derive(Clone, PartialEq, Eq, Hash)]
enum DocumentRowKey {
    LiteralWholeDocument,
    Block(usize, String),
    Footnotes,
}
impl DocumentRowKey {
    fn block(projection: ProjectionKind, index: usize, block: &Block) -> Self {
        match projection {
            ProjectionKind::LiteralWholeDocument => Self::LiteralWholeDocument,
            ProjectionKind::Parsed => Self::Block(index, row_kind(block)),
        }
    }
}
impl DocumentRow {
    fn key(&self) -> DocumentRowKey {
        match self {
            Self::Block(projection, index, block) => {
                DocumentRowKey::block(*projection, *index, block)
            }
            Self::Footnotes => DocumentRowKey::Footnotes,
        }
    }
}

/// Only user decisions outlive cells. Each mounted logical row creates its
/// own signal; the source keeps values, never handles owned by retired cells.
#[derive(Clone)]
struct BlockChoices {
    document: Signal<Projection>,
    values: Rc<RefCell<HashMap<ChoiceAddress, SavedChoice>>>,
    footnote: Option<String>,
}

struct SavedChoice {
    owners: Vec<String>,
    value: bool,
}
impl BlockChoices {
    fn new(document: Signal<Projection>) -> Self {
        Self {
            document,
            values: Rc::default(),
            footnote: None,
        }
    }

    fn for_footnote(&self, label: String) -> Self {
        Self {
            footnote: Some(label),
            ..self.clone()
        }
    }

    fn address(&self, path: &str) -> ChoiceAddress {
        ChoiceAddress {
            footnote: self.footnote.clone(),
            // The renderer's footnote key contains a display number; its
            // logical owner, and hence its choices, belong to the label.
            path: if self.footnote.is_some() {
                path.split_once('.').map_or("", |(_, path)| path).to_owned()
            } else {
                path.to_owned()
            },
        }
    }

    fn signal(&self, path: &str, initial: bool) -> Signal<bool> {
        let address = self.address(path);
        let owners = self.document.with_untracked(|d| choice_owners(d, &address));
        let initial = self
            .values
            .borrow()
            .get(&address)
            .filter(|choice| Some(&choice.owners) == owners.as_ref())
            .map_or(initial, |choice| choice.value);
        signal(initial)
    }

    fn set(&self, path: &str, value: bool) {
        let address = self.address(path);
        if let Some(owners) = self.document.with_untracked(|d| choice_owners(d, &address)) {
            self.values
                .borrow_mut()
                .insert(address, SavedChoice { owners, value });
        }
    }

    fn retain(&self, document: &Document) {
        self.values
            .borrow_mut()
            .retain(|path, choice| choice_owners(document, path).as_ref() == Some(&choice.owners));
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct ChoiceAddress {
    footnote: Option<String>,
    path: String,
}

/// Kind changes at any ancestor replace its logical owner and choices.
/// Footnotes are addressed by label, independently of their display number.
fn choice_owners(document: &Document, address: &ChoiceAddress) -> Option<Vec<String>> {
    let mut indices = address.path.split('.');
    let root = indices.next()?.parse::<usize>().ok()?;
    let mut owners = Vec::new();
    let mut block = if let Some(label) = &address.footnote {
        let note = document
            .footnotes
            .iter()
            .find(|note| &note.label == label)?;
        owners.push(format!("footnote:{}", note.label));
        note.children.get(root)?
    } else {
        document.blocks.get(root)?
    };
    owners.push(row_kind(block));
    while let Some(index) = indices.next() {
        let index = index.parse::<usize>().ok()?;
        block = match block {
            Block::Blockquote { children, .. } | Block::Details { children, .. } => {
                children.get(index)?
            }
            Block::Custom(node) => node.children.get(index)?,
            Block::List { items, .. } => {
                let item = items.get(index)?;
                owners.push(format!("item:{}", item.checked.is_some()));
                item.children.get(indices.next()?.parse::<usize>().ok()?)?
            }
            _ => return None,
        };
        owners.push(row_kind(block));
    }
    Some(owners)
}

/// Syntax highlighting of code blocks, for Rust views: given to the text
/// views below with `provide_context`, in place of the built-in one
/// (feature `highlight`, on by default: syntect, in Allsum's reading palette). The
/// app's (`tree-sitter`, its own theme, ...) returns the styles of byte
/// ranges of the code; the text view shows the code with them. A TS app
/// shows its own highlighted code with `renderCodeBlock`.
///
/// ```ignore
/// provide_context(CodeHighlighter::new(|code: &CodeBlock| my_highlighter(code)));
/// ```
#[derive(Clone)]
pub struct CodeHighlighter(Rc<HighlightFn>);

type HighlightFn = dyn Fn(&CodeBlock) -> Vec<(std::ops::Range<usize>, StyleRefinement)>;

impl CodeHighlighter {
    /// A highlighter returning the styles of byte ranges of a block's
    /// code (in order, not overlapping; what they leave out is plain).
    pub fn new(
        highlight: impl Fn(&CodeBlock) -> Vec<(std::ops::Range<usize>, StyleRefinement)> + 'static,
    ) -> Self {
        Self(Rc::new(highlight))
    }

    /// `code` in spans styled as the highlighter says.
    fn spans(&self, code: &CodeBlock) -> Vec<AnyElement> {
        let source = code.code.as_str();
        let mut out = Vec::new();
        let mut at = 0;
        for (range, style) in (self.0)(code) {
            // Ranges out of order, overlapping or off a character boundary
            // are skipped rather than trusted.
            if range.start < at
                || range.end <= range.start
                || source.get(range.clone()).is_none()
                || !source.is_char_boundary(range.start)
            {
                continue;
            }
            if range.start > at {
                out.push(text(source[at..range.start].to_owned()).into_element());
            }
            let mut span = text(source[range.clone()].to_owned());
            *span.style() = style;
            out.push(span.into_element());
            at = range.end;
        }
        if at < source.len() {
            out.push(text(source[at..].to_owned()).into_element());
        }
        out
    }
}

impl std::fmt::Debug for CodeHighlighter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodeHighlighter")
    }
}

/// What the blocks of one run are made with: the props read.
#[derive(Clone)]
struct Cx {
    selectable: bool,
    props: TextViewProps,
    source: DocumentState,
    choices: BlockChoices,
    code_scroll_indicator: bool,
    table_scrollbar: bool,
    caret: Option<Slot>,
    render_custom: Option<Renderer<CustomNode>>,
    code_block_actions: Vec<TextViewCodeAction>,
    render_table_actions: Option<Renderer<Table>>,
    render_math: Option<Renderer<TextViewMath>>,
    render_image: Option<Renderer<TextViewImageContext>>,
    plugins: Rc<MarkdownPlugins>,
    typed: TextViewParts,
    /// Whether the caret is placed in this run.
    caret_placed: Rc<std::cell::Cell<bool>>,
    /// How many lists the blocks being made are in (a copy keeps the depth
    /// it was made at, for content made later).
    list_depth: std::cell::Cell<u8>,
    /// The line height of the text being made, which images in it are
    /// sized by.
    line: std::cell::Cell<f32>,
    /// The URL of the link the content being made is in: a press on an
    /// image there is the link's.
    link: std::cell::RefCell<Option<SharedString>>,
    highlighter: Option<CodeHighlighter>,
    links: TextViewLinks,
    scope: Scope<TextViewEvent>,
}

impl Cx {
    fn read(
        props: &TextViewProps,
        scope: Scope<TextViewEvent>,
        plugins: Rc<MarkdownPlugins>,
        source: DocumentState,
        choices: BlockChoices,
    ) -> Self {
        Self {
            selectable: props.selectable.get(),
            props: *props,
            source,
            choices,
            code_scroll_indicator: props.code_block_scrollbar.get(),
            table_scrollbar: props.table_scrollbar.get(),
            caret: props.streaming_caret.get(),
            render_custom: props.render_custom.get(),
            code_block_actions: props.code_block_actions.get(),
            render_table_actions: props.render_table_actions.get(),
            render_math: props.render_math.get(),
            render_image: props.render_image.get(),
            plugins,
            typed: use_context::<TextViewParts>().unwrap_or_default(),
            highlighter: use_context::<CodeHighlighter>(),
            caret_placed: Rc::default(),
            list_depth: std::cell::Cell::new(0),
            line: std::cell::Cell::new(BODY_SIZE * BODY_LINE),
            link: std::cell::RefCell::new(None),
            links: props.links.get(),
            scope,
        }
    }

    /// What a press on a link to `url` does: reported, and opened outside
    /// the app when `links` says so.
    fn link_press(&self, url: SharedString, element: ElementRef) -> impl Fn() + Clone + 'static {
        let (scope, links) = (self.scope, self.links);
        let owner = Owner::current();
        let origin = self.source.origin();
        // The owner already owns disposal. JS only retains a weak capability;
        // a synchronous class method must never enter the reactive graph.
        let lifetime = Rc::new(());
        let weak = Rc::downgrade(&lifetime);
        cleanup(move || drop(lifetime));
        move || {
            if !origin.is_current() || !owner.is_live() || element.node().is_none() {
                return;
            }
            scope.emit(TextViewEvent::LinkPress(TextViewLinkPressEvent {
                url: url.clone(),
                target: Some(TextViewLinkTarget {
                    element,
                    owner,
                    origin: origin.clone(),
                    lifetime: weak.clone(),
                }),
            }));
            if links == TextViewLinks::Open && !url.starts_with('#') {
                drop(open_url(url.to_string()));
            }
        }
    }

    fn source(&self, el: Text, segments: Vec<nsh_core::TextSourceSegment>) -> Text {
        let source_id = self.props.source_id;
        el.text_source(move || {
            source_id.get().map(|id| {
                std::sync::Arc::new(nsh_core::TextSource::Mapped {
                    id: id.to_string().into(),
                    segments: segments.clone(),
                })
            })
        })
    }

    fn block(
        &self,
        block: Memo<Block>,
        key: String,
        tail: Memo<bool>,
        before: Memo<Before>,
    ) -> AnyElement {
        if matches!(block.get_untracked(), Block::CodeBlock(_)) {
            let code = computed(move || match block.get() {
                Block::CodeBlock(code) => code,
                _ => unreachable!(),
            });
            let render = self.props.render_code_block;
            let cx = self.clone();
            return dynamic(move || match render.get() {
                Some(render) => {
                    let key = format!("code:{key}");
                    let cx = cx.clone();
                    dynamic(move || {
                        let code = code.get();
                        cx.attachment(
                            render.render(key.clone(), code.clone()).into_element(),
                            &code.source,
                        )
                    })
                    .into_element()
                }
                None => untracked(|| cx.code_block(code, &key, tail)),
            })
            .into_element();
        }
        match block.get_untracked() {
            Block::Blockquote { alert, .. } => {
                let children = computed(move || match block.get() {
                    Block::Blockquote { children, .. } => children,
                    _ => unreachable!(),
                });
                let column = self.blocks(
                    view().flex_col().flex_1().gap(px(BLOCK_GAP)),
                    children,
                    key,
                    tail,
                );
                return if let Some(alert) = alert {
                    self.alert_frame(alert).child(column).into_element()
                } else {
                    self.part(
                        view()
                            .flex_col()
                            .border_l(px(2.0))
                            .border_color(strong_border)
                            .ps(px(BODY_SIZE * 0.9))
                            .text_color(move || theme().foreground.opacity(0.8)),
                        Part::Blockquote,
                    )
                    .child(column)
                    .into_element()
                };
            }
            Block::List { .. } => return self.list(block, key, tail),
            Block::Details { open, .. } => {
                let shown = self.choices.signal(&key, open);
                let choices = self.choices.clone();
                let choice_key = key.clone();
                let children = computed(move || match block.get() {
                    Block::Details { children, .. } => children,
                    _ => unreachable!(),
                });
                let cx = self.clone();
                let summary_cx = self.clone();
                let summary_key = key.clone();
                return self
                    .part(view().flex_col().gap(px(ITEM_GAP * 2.0)), Part::Details)
                    .child(
                        self.part(
                            view()
                                .flex_row()
                                .role(AccessibilityRole::Button)
                                .focusable(true)
                                .accessibility_state(move || AccessibilityState {
                                    expanded: Some(shown.get()),
                                    ..AccessibilityState::default()
                                })
                                .on_press(move || {
                                    let value = !shown.get_untracked();
                                    shown.set(value);
                                    choices.set(&choice_key, value);
                                }),
                            Part::Summary,
                        )
                        .child(
                            self.part(
                                text(move || if shown.get() { "▾ " } else { "▸ " })
                                    .select_none()
                                    .text_color(move || theme().muted_foreground),
                                Part::SummaryMarker,
                            ),
                        )
                        .child(dynamic(move || match block.get() {
                            Block::Details { summary, .. } => summary_cx
                                .paragraph(&summary, &summary_key, false)
                                .into_element(),
                            _ => unreachable!(),
                        })),
                    )
                    .child(dynamic(move || {
                        shown.get().then(|| {
                            cx.blocks(
                                view().flex_col().gap(px(BLOCK_GAP)),
                                children,
                                key.clone(),
                                tail,
                            )
                        })
                    }))
                    .into_element();
            }
            Block::Custom(_) => {
                let node = computed(move || match block.get() {
                    Block::Custom(node) => node,
                    _ => unreachable!(),
                });
                return self.custom(node, key, tail);
            }
            _ => {}
        }
        let cx = self.clone();
        dynamic(move || {
            let mut current = Cx::read(
                &cx.props,
                cx.scope,
                cx.plugins.clone(),
                cx.source,
                cx.choices.clone(),
            );
            current.list_depth = std::cell::Cell::new(cx.list_depth.get());
            current.line = std::cell::Cell::new(cx.line.get());
            let el = current.leaf(&block.get(), &key, tail.get(), before.get());
            if tail.get() && current.caret.is_some() && !current.caret_placed.get() {
                view()
                    .flex_col()
                    .child(el)
                    .child(current.caret_after(text(""), true))
                    .into_element()
            } else {
                el
            }
        })
        .into_element()
    }

    fn custom(&self, node: Memo<CustomNode>, key: String, tail: Memo<bool>) -> AnyElement {
        let fallback = signal(true);
        let plugins = self.plugins.clone();
        let render = self.props.render_custom;
        let hook_cx = self.clone();
        let hook_key = key.clone();
        let hook = dynamic(move || {
            let render = render.get();
            let el = if plugins.is_empty() && render.is_none() {
                None
            } else {
                let node = node.get();
                plugins
                    .render(&node)
                    .or_else(|| {
                        render.map(|render| {
                            render
                                .render(format!("custom:{hook_key}"), node.clone())
                                .into_element()
                        })
                    })
                    .map(|el| hook_cx.attachment(el, &node.source))
            };
            fallback.set(el.is_none());
            el
        });
        let children = computed(move || node.with(|node| node.children.clone()));
        let has_children = computed(move || children.with(|children| !children.is_empty()));
        let native_cx = self.clone();
        let native = when(
            move || fallback.get(),
            move || {
                let cx = native_cx.clone();
                let key = key.clone();
                dynamic(move || {
                    if has_children.get() {
                        untracked(|| {
                            cx.blocks(
                                view().flex_col().gap(px(BLOCK_GAP)),
                                children,
                                key.clone(),
                                tail,
                            )
                        })
                        .into_element()
                    } else {
                        let cx = cx.clone();
                        let key = key.clone();
                        dynamic(move || {
                            let node = node.get();
                            if !node.content.is_empty() {
                                cx.paragraph(&node.content, &key, tail.get()).into_element()
                            } else {
                                cx.caret_after(
                                    cx.source(
                                        text(node.text.clone())
                                            .when(cx.selectable, |t| t.select_text()),
                                        node.source.clone(),
                                    ),
                                    tail.get(),
                                )
                                .into_element()
                            }
                        })
                        .into_element()
                    }
                })
            },
        );
        self.part(view().flex_col().child(hook).child(native), Part::Custom)
            .into_element()
    }

    /// A custom render's single actual Text attachment has one canonical atom.
    fn attachment(&self, el: AnyElement, segments: &[nsh_core::TextSourceSegment]) -> AnyElement {
        let Some(start) = segments.iter().map(|s| s.source_start).min() else {
            return el;
        };
        let end = segments.iter().map(|s| s.source_end).max().unwrap_or(start);
        self.source(
            text("")
                .when(self.selectable, |t| t.select_text())
                .child(el),
            vec![nsh_core::TextSourceSegment {
                start: 0,
                end: 1,
                source_start: start,
                source_end: end,
                kind: nsh_core::TextSourceKind::Replacement,
            }],
        )
        .into_element()
    }

    fn footnotes(&self, footnotes: Memo<Vec<super::Footnote>>) -> AnyElement {
        let cx = self.clone();
        self.part(
            view()
                .flex_col()
                .gap(px(4.0))
                .text_size(px(SMALL_SIZE))
                .line_height(px(SMALL_SIZE * 1.6))
                .text_color(move || theme().muted_foreground),
            Part::Footnotes,
        )
        .child(each(
            footnotes,
            |note: &super::Footnote| note.label.clone(),
            move |note, _| {
                let children = computed(move || note.get().children);
                let key = format!("f{}", note.get_untracked().index);
                let mut cx = cx.clone();
                cx.choices = cx.choices.for_footnote(note.get_untracked().label);
                cx.part(view().flex_row().gap(px(6.0)), Part::Footnote)
                    .child(cx.part(
                        text(move || format!("{}.", note.get().index)).select_none(),
                        Part::FootnoteLabel,
                    ))
                    .child(cx.with_line(SMALL_SIZE * 1.6, || {
                        cx.blocks(
                            view().flex_col().flex_1().gap(px(4.0)),
                            children,
                            key,
                            computed(|| false),
                        )
                    }))
            },
        ))
        .into_element()
    }

    fn blocks<E: ParentElement + Styled>(
        &self,
        column: E,
        blocks: Memo<Vec<Block>>,
        key: String,
        tail: Memo<bool>,
    ) -> E {
        let rows = computed(move || blocks.get().into_iter().enumerate().collect::<Vec<_>>());
        let cx = self.clone();
        column.child(each(
            rows,
            |(i, block): &(usize, Block)| (*i, row_kind(block)),
            move |item, index| {
                let block = computed(move || item.get().1);
                let before = computed(move || match index.get() {
                    0 => Before::Nothing,
                    i => blocks.with(|b| Before::of(b.get(i - 1))),
                });
                let last = computed(move || tail.get() && index.get() + 1 == blocks.with(Vec::len));
                view().child(cx.block(
                    block,
                    format!("{key}.{}", item.get_untracked().0),
                    last,
                    before,
                ))
            },
        ))
    }

    fn list(&self, block: Memo<Block>, key: String, tail: Memo<bool>) -> AnyElement {
        let items = computed(move || match block.get() {
            Block::List { items, .. } => items.into_iter().enumerate().collect::<Vec<_>>(),
            _ => unreachable!(),
        });
        let ordered = matches!(block.get_untracked(), Block::List { ordered: true, .. });
        let kind = if ordered {
            Part::OrderedList
        } else {
            Part::UnorderedList
        };
        let depth = self.list_depth.get();
        let cx = self.clone();
        self.parts(view().flex_col().gap(px(ITEM_GAP)), &[Part::List, kind])
            .child(each(
                items,
                |(i, item): &(usize, ListItem)| (*i, item.checked.is_some()),
                move |item, index| {
                    let key = format!("{key}.{}", item.get_untracked().0);
                    let checked = item.get_untracked().1.checked;
                    let task = checked.is_some();
                    let done = checked == Some(true);
                    let children = computed(move || item.get().1.children);
                    let last =
                        computed(move || tail.get() && index.get() + 1 == items.with(Vec::len));
                    let mut child_cx = cx.clone();
                    child_cx.list_depth = std::cell::Cell::new(depth.saturating_add(1));
                    let content = child_cx.blocks(
                        view()
                            .flex_col()
                            .flex_1()
                            .gap(move || {
                                px(match block.get() {
                                    Block::List { loose: true, .. } => BLOCK_GAP,
                                    _ => ITEM_GAP,
                                })
                            })
                            .when(done, |v| {
                                v.text_color(move || theme().muted_foreground)
                                    .line_through()
                                    .text_decoration_color(move || {
                                        theme().muted_foreground.opacity(0.6)
                                    })
                            }),
                        children,
                        key,
                        last,
                    );
                    let marker_cx = cx.clone();
                    let marker = dynamic(move || {
                        let (ordered, start) = match block.get() {
                            Block::List { ordered, start, .. } => (ordered, start),
                            _ => unreachable!(),
                        };
                        marker_cx.list_marker(
                            ordered,
                            start,
                            index.get(),
                            item.get().1.checked,
                            depth,
                        )
                    })
                    .into_element();
                    let (before, inside) = if task {
                        (Some(marker), None)
                    } else {
                        (None, Some(marker))
                    };
                    let row = view().flex_row().map(|v| {
                        if task {
                            v.gap(px(8.0)).ps(px(1.5))
                        } else {
                            v.ps(px(LIST_INDENT))
                        }
                    });
                    cx.part(row, Part::ListItem)
                        .child(before)
                        .child(cx.part(content.child(inside), Part::ListItemContent))
                },
            ))
            .into_element()
    }

    fn list_marker(
        &self,
        ordered: bool,
        start: u32,
        index: usize,
        checked: Option<bool>,
        depth: u8,
    ) -> AnyElement {
        match checked {
            Some(checked) => {
                let mut parts = vec![Part::ListMarker, Part::TaskMarker];
                if checked {
                    parts.push(Part::TaskMarkerChecked);
                }
                // A box centered on the first line.
                let marker = view()
                    .flex_none()
                    .size(px(TASK_BOX))
                    .mt(px((BODY_SIZE * BODY_LINE - TASK_BOX) / 2.0))
                    .rounded(px(4.0))
                    .border(px(1.5))
                    .items_center()
                    .justify_center()
                    .role(AccessibilityRole::Checkbox)
                    .accessibility_state(AccessibilityState {
                        checked: Some(if checked {
                            nsh_core::Checked::True
                        } else {
                            nsh_core::Checked::False
                        }),
                        ..AccessibilityState::default()
                    });
                let marker = if checked {
                    marker
                        .bg(move || theme().primary)
                        .border_color(move || theme().primary)
                        .child(
                            text("✓")
                                .select_none()
                                .text_size(px(11.0))
                                .line_height(px(13.0))
                                .font_weight(FontWeight::BOLD)
                                .text_color(move || theme().primary_foreground),
                        )
                } else {
                    marker.border_color(move || theme().muted_foreground)
                };
                self.parts(marker, &parts).into_element()
            }
            None => {
                let marker = if ordered {
                    format!("{}.", start as usize + index)
                } else {
                    // A browser's markers by depth: disc, circle, square.
                    match depth {
                        0 => "•",
                        1 => "◦",
                        _ => "▪",
                    }
                    .to_owned()
                };
                // In the indent before the content, its end against
                // it, as a browser places it: wider numbers reach
                // further left and the content stays in line.
                let marker = text(marker)
                    .select_none()
                    .absolute()
                    .top(px(0.0))
                    .right(relative(1.0))
                    .w(px(MARKER_BOX))
                    .pe(px(6.0))
                    .text_right()
                    .text_color(move || theme().muted_foreground);
                self.part(marker, Part::ListMarker).into_element()
            }
        }
    }

    /// `el` with part `part`'s classes and style.
    fn part<E: Element>(&self, el: E, part: Part) -> E {
        self.parts(el, &[part])
    }

    /// `el` with the classes and styles of `parts`, in order.
    fn parts<E: Element>(&self, mut el: E, parts: &[Part]) -> E {
        if !self.typed.is_empty() {
            for part in parts {
                let style = std::mem::take(el.style());
                *el.style() = self.typed.refine(*part, style);
            }
        }
        let class_prop = self.props.classes;
        let style_prop = self.props.styles;
        let class_parts = parts.to_vec();
        let style_parts = parts.to_vec();
        el.app_class(move || {
            class_prop.with(|classes| {
                let classes = class_parts
                    .iter()
                    .filter_map(|p| classes.get(*p))
                    .map(|s| s.as_ref())
                    .collect::<Vec<&str>>()
                    .join(" ");
                (!classes.is_empty()).then(|| SharedString::from(classes))
            })
        })
        .inline_style(move || {
            style_prop.with(|styles| {
                Style::from_decls(
                    style_parts
                        .iter()
                        .filter_map(|p| styles.get(*p))
                        .flat_map(|s| s.decls().iter().cloned()),
                )
            })
        })
    }

    /// A text of the block's inline content, selectable when asked.
    fn paragraph(&self, content: &[Inline], key: &str, tail: bool) -> Text {
        let el = text("")
            .when(self.selectable, |t| t.select_text())
            .children(self.inlines(content, key));
        self.caret_after(el, tail)
    }

    /// The caret at the end of `el` when it is the last text.
    fn caret_after<E: ParentElement>(&self, el: E, tail: bool) -> E {
        if tail && !self.caret_placed.replace(true) {
            el.slot(self.caret, |s| s)
        } else {
            el
        }
    }

    fn leaf(&self, block: &Block, key: &str, tail: bool, before: Before) -> AnyElement {
        match block {
            Block::Paragraph { content } => match only_images(content) {
                // Images with no text around them are blocks: as wide as
                // they ask, at most the text's width.
                Some(images) => self
                    .part(self.image_column(&images, key), Part::Paragraph)
                    .into_element(),
                None => self
                    .part(self.paragraph(content, key, tail), Part::Paragraph)
                    .into_element(),
            },
            Block::Heading { level, content, .. } => {
                let part = match level {
                    1 => Part::Heading1,
                    2 => Part::Heading2,
                    3 => Part::Heading3,
                    4 => Part::Heading4,
                    5 => Part::Heading5,
                    _ => Part::Heading6,
                };
                let h = Heading::of(*level);
                let el = self
                    .with_line(h.size * h.line, || self.paragraph(content, key, tail))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_size(px(h.size))
                    .line_height(px(h.size * h.line))
                    .letter_spacing(px(h.size * h.tracking))
                    .mt(px(h.margin_top(before)))
                    .role(AccessibilityRole::Header);
                self.parts(el, &[Part::Heading, part]).into_element()
            }
            Block::Math { tex, source } => match &self.render_math {
                Some(render) => self.attachment(
                    render
                        .render(
                            format!("math:{key}"),
                            TextViewMath {
                                tex: tex.clone().into(),
                                display: true,
                            },
                        )
                        .into_element(),
                    source,
                ),
                // Its TeX in a box as a code block's, as gpui-kit shows a
                // formula it has no renderer for.
                None => self
                    .part(
                        view()
                            .py(px(14.0))
                            .px(px(16.0))
                            .rounded(px(8.0))
                            .border_1()
                            .border_color(move || theme().border)
                            .bg(move || theme().muted)
                            .child(
                                self.source(text(tex.clone()), source.clone())
                                    .font_family(mono_font)
                                    .text_size(px(CODE_SIZE))
                                    .line_height(px(CODE_SIZE * CODE_LINE))
                                    .when(self.selectable, |t| t.select_text()),
                            ),
                        Part::MathBlock,
                    )
                    .into_element(),
            },
            Block::Table(table) => self.table(table, key, tail),
            Block::Rule => self
                .part(
                    view()
                        .border_t_1()
                        .border_color(strong_border)
                        // 1.6em in all with the gap.
                        .my(px(BODY_SIZE * 1.6 - BLOCK_GAP)),
                    Part::Rule,
                )
                .into_element(),
            Block::Blockquote { .. }
            | Block::List { .. }
            | Block::CodeBlock(_)
            | Block::Details { .. }
            | Block::Custom(_) => unreachable!("containers use the Memo renderer"),
        }
    }

    fn alert_frame(&self, alert: Alert) -> View {
        let (part, glyph) = match alert {
            Alert::Note => (Part::AlertNote, "i"),
            Alert::Tip => (Part::AlertTip, "✓"),
            Alert::Important => (Part::AlertImportant, "i"),
            Alert::Warning => (Part::AlertWarning, "!"),
            Alert::Caution => (Part::AlertCaution, "!"),
        };
        let tint = move || alert_color(alert);
        let icon = view()
            .flex_none()
            .size(px(ALERT_ICON))
            .mt(px((BODY_SIZE * BODY_LINE - ALERT_ICON) / 2.0))
            .rounded_full()
            .border(px(1.5))
            .border_color(tint)
            .items_center()
            .justify_center()
            .child(
                text(glyph)
                    .select_none()
                    .text_size(px(10.0))
                    .line_height(px(12.0))
                    .font_weight(FontWeight::BOLD)
                    .text_color(tint),
            );
        let row = view()
            .flex_row()
            .gap(px(10.0))
            .py(px(12.0))
            .px(px(16.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(move || tint().opacity(0.3))
            .bg(move || tint().opacity(0.08));
        self.parts(row, &[Part::Blockquote, Part::Alert, part])
            .child(self.part(icon, Part::AlertIcon))
    }

    /// The row owns controls and Wrap state. Only the code body changes as
    /// the source grows, so keyboard focus and the user's wrap choice survive.
    fn code_block(&self, code: Memo<CodeBlock>, key: &str, tail: Memo<bool>) -> AnyElement {
        let wrapped = self.choices.signal(
            key,
            self.code_block_actions
                .iter()
                .any(|a| a.id.as_ref() == "wrap"),
        );
        let props = self.props;
        let actions = computed(move || props.code_block_actions.get());
        let action_cx = self.clone();
        let action_key = key.to_owned();
        let language = computed(move || code.get().language.unwrap_or_default());
        // The language at the start, the actions at the end.
        let header = self
            .part(
                view().flex_row().items_center().gap(px(4.0)),
                Part::CodeBlockHeader,
            )
            .child(self.part(
                text(move || SharedString::from(language.get()))
                    .select_none()
                    .flex_1()
                    .min_w(px(0.0)),
                Part::CodeBlockLanguage,
            ))
            .child(each(
                actions,
                |action: &TextViewCodeAction| action.id.clone(),
                move |action, _| {
                    let action = computed(move || action.get());
                    let key = format!("{action_key}.{}", action.get_untracked().id);
                    action_cx.code_action_live(action, code, wrapped, &key, &action_key)
                },
            ));
        let cx = self.clone();
        self.part(
            view()
                .flex_col()
                .rounded(px(8.0))
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().muted)
                .text_size(px(CODE_SIZE))
                .line_height(px(CODE_SIZE * CODE_LINE)),
            Part::CodeBlock,
        )
        .child(header)
        .child(dynamic(move || {
            let cx = Cx::read(
                &cx.props,
                cx.scope,
                cx.plugins.clone(),
                cx.source,
                cx.choices.clone(),
            );
            let code = code.get();
            let body = match &cx.highlighter {
                Some(h) => text("").children(h.spans(&code)),
                None => match super::highlight::built_in(&code) {
                    Some(spans) => text("").children(spans),
                    None => text(code.code.clone()),
                },
            };
            let body = cx
                .source(body, code.source.clone())
                .font_family(mono_font)
                .px(px(16.0))
                .py(px(14.0))
                .min_w(px(0.0))
                .when(wrapped.get(), |t| t.w_full())
                .when(cx.selectable, |t| t.select_text());
            let body = cx.caret_after(body, tail.get());
            let scope = cx.scope;
            cx.part(
                scroll()
                    .when(!wrapped.get(), |s| s.horizontal())
                    .scrollable(!wrapped.get())
                    .scrollbar(cx.code_scroll_indicator)
                    .on_scroll_intent(move |_: &ScrollIntent| {
                        scope.emit(TextViewEvent::ScrollIntent)
                    }),
                Part::CodeBlockScroll,
            )
            .child(cx.part(body, Part::CodeBlockCode))
        }))
        .into_element()
    }

    /// A table as one grid, so its columns line up across rows: each column
    /// fits its content when there is room (the spare width shared out),
    /// shrinks (its cells wrapping) down to a floor when the view is
    /// narrower, and below the floors the grid keeps them and scrolls
    /// horizontally ([`column_floor`]).
    ///
    /// A row is a view behind its cells (the same grid row, every column),
    /// so its classes draw backgrounds and borders; text styles go on the
    /// cells.
    fn table(&self, table: &Table, key: &str, tail: bool) -> AnyElement {
        self.with_line(TABLE_SIZE * TABLE_LINE, || {
            self.table_grid(table, key, tail)
        })
    }

    /// A code block's action: a ghost button (its background shows while
    /// hovered or pressed) around the action's icon.
    fn code_action_live(
        &self,
        action: Memo<TextViewCodeAction>,
        code: Memo<CodeBlock>,
        wrapped: Signal<bool>,
        key: &str,
        choice_key: &str,
    ) -> AnyElement {
        let scope = self.scope;
        let owner = Owner::current();
        let choices = self.choices.clone();
        let choice_key = choice_key.to_owned();
        let id = action.get_untracked().id;
        let copy = id.as_ref() == "copy";
        let wrap = id.as_ref() == "wrap";
        let label = computed(move || {
            let action = action.get();
            action.label.unwrap_or(action.id)
        });
        let labels = self.props.labels;
        let done = animated_value(0.0);
        let copied = signal(false);
        let icon = if copy {
            copy_icon(&done)
        } else {
            let render = self.props.render_code_block_action;
            let key = format!("action:{key}");
            dynamic(move || match render.get() {
                Some(render) => render.render(key.clone(), action.get()).into_element(),
                None => text(move || label.get())
                    .select_none()
                    .text_size(px(11.0))
                    .into_element(),
            })
            .into_element()
        };
        view()
            .flex_row()
            .gap(px(4.0))
            .min_w(px(24.0))
            .h(px(24.0))
            .px(px(5.0))
            .rounded(px(6.0))
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(|s| s.bg(theme().foreground.opacity(0.08)))
            .active(|s| s.bg(theme().foreground.opacity(0.14)))
            .role(AccessibilityRole::Button)
            .focusable(true)
            .label(move || label.get())
            .accessibility_state(move || AccessibilityState {
                selected: wrap && wrapped.get(),
                ..AccessibilityState::default()
            })
            .on_press(move || {
                if !owner.is_live() {
                    return;
                }
                let code = code.get_untracked();
                if wrap {
                    let value = !wrapped.get_untracked();
                    wrapped.set(value);
                    choices.set(&choice_key, value);
                }
                if copy {
                    set_clipboard(code.code.clone());
                    copied.set(true);
                    let _ = done.spring(
                        1.0,
                        Spring {
                            stiffness: 320.0,
                            damping: 18.0,
                            ..Spring::default()
                        },
                    );
                    set_timeout(std::time::Duration::from_millis(1600), move || {
                        copied.set(false);
                        let _ = done.timing(0.0, 180.0, Easing::EaseOut);
                    });
                }
                scope.emit(TextViewEvent::CodeBlockAction(TextViewCodeActionEvent {
                    id: id.clone(),
                    code,
                }));
            })
            .child(icon)
            .child(
                text(move || {
                    if copied.get() {
                        labels.with(|labels| labels.copied.clone().unwrap_or_default())
                    } else {
                        "".into()
                    }
                })
                .select_none(),
            )
            .into_element()
    }

    fn table_grid(&self, table: &Table, key: &str, tail: bool) -> AnyElement {
        let last_row = table.rows.len();
        let columns = table.columns();
        let align = |i: usize| table.align.get(i).copied().unwrap_or_default();
        // The cells that start at column `c` and span it alone (a spanning
        // cell's width is shared by its columns).
        let at = |row: &'_ [super::TableCell], c: usize| -> Option<usize> {
            let mut col = 0;
            for (i, cell) in row.iter().enumerate() {
                if col == c {
                    return (cell.span() == 1).then_some(i);
                }
                col += cell.span();
                if col > c {
                    return None;
                }
            }
            None
        };
        let floors: Vec<f32> = (0..columns)
            .map(|c| {
                let cells = std::iter::once(&table.head).chain(&table.rows);
                column_floor(cells.filter_map(|row| at(row, c).map(|i| &row[i])))
            })
            .collect();
        let tracks = floors
            .iter()
            .map(|f| format!("minmax({f:.2}rem, auto)"))
            .collect::<Vec<_>>()
            .join(" ");
        let mut grid = Vec::with_capacity((columns + 1) * (last_row + 1));
        let rows = std::iter::once(&table.head).chain(&table.rows);
        for (r, cells) in rows.enumerate() {
            let head = r == 0;
            let line = i16::try_from(r + 1).unwrap_or(i16::MAX);
            let row_parts: &[Part] = if head {
                &[Part::TableRow, Part::TableHead]
            } else {
                &[Part::TableRow]
            };
            let cell_parts: &[Part] = if head {
                &[Part::TableCell, Part::TableHeaderCell]
            } else {
                &[Part::TableCell]
            };
            // First, so the cells are drawn over it.
            let row = view()
                .row_start(line)
                .col_span_full()
                .when(head, |v| v.bg(move || theme().muted));
            grid.push(self.parts(row, row_parts).into_element());
            // Each cell where it starts, as wide as it spans; the columns no
            // cell covers (a short row) are empty cells.
            let mut placed = Vec::new();
            let mut col = 0;
            for cell in cells.iter() {
                if col >= columns {
                    break;
                }
                let span = cell.span().min(columns - col);
                placed.push((col, span, cell.content.as_slice()));
                col += span;
            }
            placed.extend((col..columns).map(|c| (c, 1, &[][..])));
            grid.extend(placed.into_iter().map(|(c, span, content)| {
                let end = tail && r == last_row && c + span == columns;
                let key = format!("{key}.{r}.{c}");
                let t = match only_images(content) {
                    Some(images) => {
                        let column = self.image_column(&images, &key);
                        match align(c) {
                            ColumnAlign::Center => column.items_center(),
                            ColumnAlign::Right => column.items_end(),
                            ColumnAlign::Left | ColumnAlign::None => column,
                        }
                        .into_element()
                    }
                    None => {
                        let t = self.paragraph(content, &key, end);
                        match align(c) {
                            ColumnAlign::Center => t.text_center(),
                            ColumnAlign::Right => t.text_right(),
                            ColumnAlign::Left => t.text_left(),
                            ColumnAlign::None => t,
                        }
                        .into_element()
                    }
                };
                // On the cell, so its classes can set another weight. Each
                // cell draws its right and bottom lines, the grid the top
                // and left ones: no line is drawn twice.
                let cell = view()
                    .row_start(line)
                    // Start and end lines: a span would replace the start.
                    .col_start(i16::try_from(c + 1).unwrap_or(i16::MAX))
                    .col_end(i16::try_from(c + 1 + span).unwrap_or(i16::MAX))
                    .py(px(8.0))
                    .px(px(12.0))
                    .border_r_1()
                    .border_b_1()
                    .border_color(move || theme().border)
                    .when(head, |v| {
                        v.text_size(px(CODE_SIZE))
                            .text_color(move || theme().muted_foreground)
                    });
                self.parts(cell, cell_parts).child(t).into_element()
            }));
        }
        let actions = self
            .render_table_actions
            .as_ref()
            .map(|r| r.render(format!("table:{key}"), table.clone()));
        // As wide as the view, never narrower than the floors: past them,
        // the scroll view moves it.
        let grid = view()
            .grid()
            .grid_template_columns(SharedString::from(tracks))
            .w_full()
            .min_w(rems(floors.iter().sum()))
            .border_t_1()
            .border_l_1()
            .border_color(move || theme().border)
            .children(grid);
        let table = view()
            .flex_col()
            .text_size(px(TABLE_SIZE))
            .line_height(px(TABLE_SIZE * TABLE_LINE));
        self.part(table, Part::Table)
            .child(actions)
            .child(
                self.part(
                    scroll()
                        .horizontal()
                        .scrollbar(self.table_scrollbar)
                        .optional_label({
                            let labels = self.props.labels;
                            move || labels.with(|labels| labels.table.clone())
                        })
                        .on_scroll_intent({
                            let scope = self.scope;
                            move |_: &ScrollIntent| scope.emit(TextViewEvent::ScrollIntent)
                        }),
                    Part::TableScroll,
                )
                .child(grid),
            )
            .into_element()
    }

    /// The spans of `content`.
    fn inlines(&self, content: &[Inline], key: &str) -> Vec<AnyElement> {
        content
            .iter()
            .enumerate()
            .map(|(i, inline)| self.inline(inline, &format!("{key}.{i}")))
            .collect()
    }

    fn span(&self, content: &[Inline], key: &str) -> Text {
        text("").children(self.inlines(content, key))
    }

    fn inline(&self, inline: &Inline, key: &str) -> AnyElement {
        match inline {
            Inline::Source { content, segments } => {
                if matches!(content.as_slice(), [Inline::Math { .. }]) && self.render_math.is_some()
                {
                    self.attachment(self.inline(&content[0], key), segments)
                } else {
                    self.source(self.span(content, key), segments.clone())
                        .into_element()
                }
            }
            Inline::Text { text: t } => text(t.clone()).into_element(),
            Inline::Strong { content } => self
                .part(
                    self.span(content, key).font_weight(FontWeight::SEMIBOLD),
                    Part::Strong,
                )
                .into_element(),
            Inline::Emphasis { content } => self
                .part(self.span(content, key).italic(), Part::Emphasis)
                .into_element(),
            Inline::Strikethrough { content } => self
                .part(self.span(content, key).line_through(), Part::Strikethrough)
                .into_element(),
            Inline::Underline { content } => self
                .part(self.span(content, key).underline(), Part::Underline)
                .into_element(),
            Inline::Highlight { content, color } => {
                // The document's color, else the view's own.
                let color = color.as_deref().and_then(|c| c.parse::<Hsla>().ok());
                let span = self
                    .span(content, key)
                    .bg(move || color.map_or_else(|| HIGHLIGHT.opacity(0.4), AdaptiveColor::from))
                    .rounded(px(3.0));
                // A solid color of the document's is the same in both
                // appearances: its text takes the ink that reads on it
                // (as Allsum's `--mark-solid-text`), not the page's.
                let span = match color {
                    Some(c) => span.text_color(ink_on(c)),
                    None => span,
                };
                self.part(span, Part::Highlight).into_element()
            }
            Inline::Superscript { content } => self
                .part(
                    self.span(content, key).text_size(rems(0.75)),
                    Part::Superscript,
                )
                .into_element(),
            Inline::Subscript { content } => self
                .part(
                    self.span(content, key).text_size(rems(0.75)),
                    Part::Subscript,
                )
                .into_element(),
            // As a browser's `smaller`: 13 of the body's 15.
            Inline::Small { content } => self
                .part(self.span(content, key).text_size(px(13.0)), Part::Small)
                .into_element(),
            Inline::Code { code } => self
                .part(code_span(text(code.clone())), Part::Code)
                .into_element(),
            Inline::Keyboard { text: keys } => self
                .part(code_span(text(keys.clone())), Part::Keyboard)
                .into_element(),
            Inline::Link {
                url,
                title,
                content,
            } => {
                let url = SharedString::from(url.clone());
                let outer = self.link.replace(Some(url.clone()));
                let span = self.span(content, key);
                let mut label = String::new();
                super::document::inline_text(content, &mut label);
                self.link.replace(outer);
                let target = element_ref();
                let el = span
                    .element_ref(&target)
                    .focusable(true)
                    .text_color(move || theme().primary)
                    .underline()
                    .text_decoration_color(move || theme().primary.opacity(0.4))
                    .text_decoration_thickness(px(1.0))
                    .underline_offset(px(3.0))
                    .role(AccessibilityRole::Link)
                    .label(SharedString::from(label))
                    .when_some(title.clone(), |t, title| t.hint(title))
                    .on_press(self.link_press(url, target));
                self.part(el, Part::Link).into_element()
            }
            Inline::Image(image) => {
                let link = self.link.borrow().clone();
                self.image(image, link, ImageFlow::Inline(self.line.get()), key)
            }
            Inline::Math { tex } => match &self.render_math {
                Some(render) => render
                    .render(
                        format!("math:{key}"),
                        TextViewMath {
                            tex: tex.clone().into(),
                            display: false,
                        },
                    )
                    .into_element(),
                None => self
                    .part(code_span(text(tex.clone())), Part::Math)
                    .into_element(),
            },
            Inline::Break => text("\n").into_element(),
            Inline::FootnoteReference { label, index } => {
                let url = SharedString::from(format!("#footnote-{label}"));
                let target = element_ref();
                self.part(
                    text(index.to_string())
                        .text_size(rems(0.75))
                        .text_color(move || theme().primary)
                        .role(AccessibilityRole::Link)
                        .focusable(true)
                        .element_ref(&target)
                        .on_press(self.link_press(url, target)),
                    Part::FootnoteReference,
                )
                .into_element()
            }
            Inline::Custom(node) => {
                if let Some(el) = self.plugins.render(node) {
                    return self.attachment(el, &node.source);
                }
                if let Some(render) = &self.render_custom {
                    return self.attachment(
                        render
                            .render(format!("custom:{key}"), node.clone())
                            .into_element(),
                        &node.source,
                    );
                }
                let el = if node.content.is_empty() {
                    self.source(text(node.text.clone()), node.source.clone())
                } else {
                    self.span(&node.content, key)
                };
                self.part(el, Part::Custom).into_element()
            }
        }
    }

    /// `f`'s result, made with images in text sized by line height
    /// `line`.
    fn with_line<R>(&self, line: f32, f: impl FnOnce() -> R) -> R {
        let outer = self.line.replace(line);
        let out = f();
        self.line.set(outer);
        out
    }

    /// Images that stand alone (a paragraph or a cell with no text), one
    /// under another.
    fn image_column(&self, images: &[ImageOnly<'_>], key: &str) -> View {
        view()
            .flex_col()
            .w_full()
            .items_start()
            .children(images.iter().enumerate().map(|(i, (image, link, source))| {
                let link = link.map(|l| SharedString::from(l.to_owned()));
                let image = self.image(image, link, ImageFlow::Block, &format!("{key}.{i}"));
                self.source(
                    text("")
                        .w_full()
                        .when(self.selectable, |t| t.select_text())
                        .child(image),
                    source.unwrap_or_default().to_vec(),
                )
            }))
    }

    /// Image `image`, in a link to `link` if it is in one (a press on it is
    /// the link's), sized as `flow` says.
    fn image(
        &self,
        image: &Image,
        link: Option<SharedString>,
        flow: ImageFlow,
        key: &str,
    ) -> AnyElement {
        let scope = self.scope;
        let target = element_ref();
        let pressed = image.clone();
        let is_link = link.is_some();
        let press_link = link.clone().map(|url| self.link_press(url, target));
        let press = move || match &press_link {
            Some(press) => press(),
            None => scope.emit(TextViewEvent::ImagePress(pressed.clone())),
        };
        let role = if is_link {
            AccessibilityRole::Link
        } else {
            AccessibilityRole::ImageButton
        };
        if let Some(render) = &self.render_image {
            let el = render.render(
                format!("image:{key}"),
                TextViewImageContext {
                    image: image.clone(),
                    linked: is_link,
                    flow: match flow {
                        ImageFlow::Block => TextViewImageFlow::Block,
                        ImageFlow::Inline(_) => TextViewImageFlow::Inline,
                    },
                    line_height: match flow {
                        ImageFlow::Inline(line) => line,
                        ImageFlow::Block => self.line.get(),
                    },
                },
            );
            if is_link && matches!(flow, ImageFlow::Block) {
                return view()
                    .role(role)
                    .focusable(true)
                    .element_ref(&target)
                    .label(SharedString::from(image.alt.clone()))
                    .on_press(press)
                    .child(el)
                    .into_element();
            }
            return el.into_element();
        }
        let (width, height) = (image.width, image.height);
        // Its natural size (a pixel a point, as a browser takes it), once
        // known, for what its own size leaves to its aspect ratio.
        let natural = signal(None::<Size<Points>>);
        let sized =
            matches!(
                (width, height),
                (Some(ImageLength::Points(_)), Some(ImageLength::Points(_)))
            ) || matches!(flow, ImageFlow::Inline(_)) && width.is_some() && height.is_some();
        if !sized {
            let src = image.src.clone();
            spawn(async move {
                if let Ok(size) = image_size(src).await {
                    natural.set(Some(Size::new(
                        px(size.width.0 as f32),
                        px(size.height.0 as f32),
                    )));
                }
            });
        }
        let aspect = move || {
            natural
                .get()
                .filter(|s| s.width > px(0.0) && s.height > px(0.0))
                .map(|s| s.width / s.height)
        };
        let el = nsh_core::element::image(image.src.clone())
            .object_fit(ResizeMode::Contain)
            .label(SharedString::from(image.alt.clone()))
            .when_some(image.title.clone(), |el, title| el.hint(title));
        let el = match flow {
            // At most as wide as the text: as wide as it asks, the height
            // following (at its natural size when it asks for nothing). The
            // width is a box's around it, so the image's height follows
            // the width it ends up with, not the one it asked for.
            ImageFlow::Block => {
                let ratio = match (width, height) {
                    (Some(ImageLength::Points(w)), Some(ImageLength::Points(h))) if h > px(0.0) => {
                        Some(w / h)
                    }
                    _ => None,
                };
                let box_width = move || -> Length {
                    match (width, height) {
                        (Some(w), _) => DefiniteLength::from(w).into(),
                        (None, Some(ImageLength::Points(h))) => {
                            (h * aspect().unwrap_or(1.0)).into()
                        }
                        (None, _) => natural.get().map_or(px(0.0), |s| s.width).into(),
                    }
                };
                let el = el
                    .rounded(px(8.0))
                    .w_full()
                    .aspect_ratio(move || ratio.or_else(aspect).unwrap_or(1.0));
                let el = el
                    .role(role)
                    .focusable(true)
                    .element_ref(&target)
                    .on_press(press);
                return view()
                    .w(box_width)
                    .max_w(relative(1.0))
                    .child(self.part(el, Part::Image))
                    .into_element();
            }
            // In a line of text: its size, else as tall as most of the
            // line, as gpui-kit's text flow sizes images.
            ImageFlow::Inline(line) => {
                let size = move || inline_image_size(width, height, aspect(), line);
                // An attachment sits on the baseline; moved down (drawing
                // only) so its middle is the middle of the lowercase
                // letters, about 0.35 em above the baseline: centered on
                // the line. The text's size is its line's over 1.7.
                let em = line / 1.7;
                el.w(move || size().width)
                    .h(move || size().height)
                    .translate_y(move || size().height / 2.0 - px(0.35 * em))
            }
        };
        let el = el
            .role(role)
            .focusable(true)
            .element_ref(&target)
            .on_press(press);
        self.part(el, Part::Image).into_element()
    }
}

/// A container changes presentation kind as its opening syntax completes.
/// Ordinary value updates (including a growing code body) retain the row.
fn row_kind(block: &Block) -> String {
    match block {
        Block::Blockquote {
            alert: Some(alert), ..
        } => format!("alert:{alert:?}"),
        _ => block.kind().to_owned(),
    }
}

/// Where an image is laid out.
#[derive(Debug, Clone, Copy)]
enum ImageFlow {
    /// On its own: a block.
    Block,
    /// In text whose lines are this tall.
    Inline(f32),
}

/// The images of content that is only images (each in a link or not), with
/// their links: shown as blocks, as gpui-kit shows a paragraph of images
/// with no text.
type ImageOnly<'a> = (
    &'a Image,
    Option<&'a str>,
    Option<&'a [nsh_core::TextSourceSegment]>,
);
fn only_images(content: &[Inline]) -> Option<Vec<ImageOnly<'_>>> {
    fn walk<'a>(
        content: &'a [Inline],
        link: Option<&'a str>,
        source: Option<&'a [nsh_core::TextSourceSegment]>,
        out: &mut Vec<ImageOnly<'a>>,
    ) -> bool {
        content.iter().all(|inline| match inline {
            Inline::Image(image) => {
                out.push((image, link, source));
                true
            }
            Inline::Source { content, segments } => walk(content, link, Some(segments), out),
            Inline::Link { url, content, .. } => walk(content, Some(url), source, out),
            _ => false,
        })
    }
    let mut out = Vec::new();
    (walk(content, None, None, &mut out) && !out.is_empty()).then_some(out)
}

/// The size of an image in text with lines `line` tall, as gpui-kit's text
/// flow sizes it: its width and height, one of them and the other from its
/// aspect ratio (`aspect`, once known; a line until then), or neither and
/// three quarters of a line tall. A percentage is of the line's height,
/// the length gpui-kit resolves it against in text.
fn inline_image_size(
    width: Option<ImageLength>,
    height: Option<ImageLength>,
    aspect: Option<f32>,
    line: f32,
) -> Size<Points> {
    let resolve = |length: ImageLength| match length {
        ImageLength::Points(points) => points,
        ImageLength::Fraction(fraction) => fraction.of(px(line)),
    };
    let (w, h) = match (width.map(resolve), height.map(resolve)) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => (w, aspect.map_or(px(line), |a| w / a)),
        (None, Some(h)) => (aspect.map_or(h, |a| h * a), h),
        (None, None) => {
            let h = px(line * 0.75);
            (h * aspect.unwrap_or(1.0), h)
        }
    };
    Size::new(w.max(px(1.0)), h.max(px(1.0)))
}

#[module]
impl TextView {
    /// Markdown `markdown` read into a document, as the `markdown` prop
    /// reads it (with `options` and `extensions`).
    pub fn parse(
        markdown: String,
        options: Option<MarkdownOptions>,
        extensions: Option<Vec<MarkdownExtension>>,
    ) -> Document {
        Parser::new()
            .options(options.unwrap_or_default())
            .extensions(extensions.unwrap_or_default())
            .markdown(&markdown)
    }

    /// HTML `html` read into a document, as the `html` prop reads it.
    pub fn parse_html(html: String, extensions: Option<Vec<MarkdownExtension>>) -> Document {
        Parser::new()
            .extensions(extensions.unwrap_or_default())
            .html(&html)
    }

    /// The text of `document` without markup (what copying a whole reply
    /// gives): blocks separated by blank lines, list items and table rows
    /// by line breaks, cells by tabs.
    pub fn plain_text(document: Document) -> String {
        document.plain_text()
    }
}

/// Lines that stand out more than the theme's borders (quotes' and
/// rules'): the text's color, faint.
fn strong_border() -> AdaptiveColor {
    theme().foreground.opacity(0.15)
}

/// Code in text: monospace, smaller, on a rounded background (the text's
/// color, faint, so it shows on any surface).
fn code_span(span: Text) -> Text {
    span.font_family(mono_font)
        .text_size(px(CODE_SIZE))
        .bg(move || theme().foreground.opacity(0.06))
        .rounded(px(4.0))
}

/// The color of an alert of kind `alert`: GitHub's alert colors (shadcn's
/// tokens have no status colors), a caution the theme's `destructive`.
fn alert_color(alert: Alert) -> AdaptiveColor {
    match alert {
        Alert::Note => AdaptiveColor::rgb(0x0969da, 0x4493f8),
        Alert::Tip => AdaptiveColor::rgb(0x1a7f37, 0x3fb950),
        Alert::Important => AdaptiveColor::rgb(0x8250df, 0xab7df8),
        Alert::Warning => AdaptiveColor::rgb(0x9a6700, 0xd29922),
        Alert::Caution => theme().destructive,
    }
}

/// Highlighted text's background, at 40% (`==text==`, `<mark>`): a
/// marker's yellow.
const HIGHLIGHT: AdaptiveColor = AdaptiveColor::rgb(0xfde047, 0xca8a04);

/// The theme's monospaced font (`font-mono`), else the system's.
fn mono_font() -> SharedString {
    theme()
        .font_mono
        .clone()
        .unwrap_or_else(|| SharedString::from("monospace"))
}

// The reading typography (sizes in points), after Allsum's documents.

/// The text's size.
const BODY_SIZE: f32 = 15.0;
/// The text's line height, a multiple of its size.
const BODY_LINE: f32 = 1.7;
/// The size of code.
const CODE_SIZE: f32 = 13.0;
/// The line height of code blocks, a multiple of [`CODE_SIZE`].
const CODE_LINE: f32 = 1.6;
/// The size of footnotes' text.
const SMALL_SIZE: f32 = 13.0;
/// The size of tables' text.
const TABLE_SIZE: f32 = 14.0;
/// The line height of tables' text, a multiple of [`TABLE_SIZE`].
const TABLE_LINE: f32 = 1.55;
/// The space between blocks (0.75em).
const BLOCK_GAP: f32 = BODY_SIZE * 0.75;
/// The space between list items (0.25em).
const ITEM_GAP: f32 = BODY_SIZE * 0.25;
/// The indent of list items, their markers in it (1.4em).
const LIST_INDENT: f32 = BODY_SIZE * 1.4;
/// The width of the box a list marker is right-aligned in, before the
/// content (its overflow reaches left of the indent, as numbers past 9 do
/// in a browser).
const MARKER_BOX: f32 = BODY_SIZE * 3.0;
/// The size of a task item's box.
const TASK_BOX: f32 = 15.0;
/// The size of an alert's icon.
const ALERT_ICON: f32 = 16.0;

/// What comes before a block in its column, for the room above it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Before {
    /// Nothing: the block is the first.
    Nothing,
    /// A heading.
    Heading,
    /// Another block.
    Block,
}

impl Before {
    fn of(block: Option<&Block>) -> Self {
        match block {
            None => Self::Nothing,
            Some(Block::Heading { .. }) => Self::Heading,
            Some(_) => Self::Block,
        }
    }
}

/// A heading level's typography.
struct Heading {
    size: f32,
    /// The line height, a multiple of the size.
    line: f32,
    /// The letter spacing, in ems.
    tracking: f32,
    /// The room above it after a block, in ems.
    above: f32,
}

impl Heading {
    fn of(level: u8) -> Self {
        match level {
            1 => Self {
                size: 27.0,
                line: 1.25,
                tracking: -0.02,
                above: 1.1,
            },
            2 => Self {
                size: 20.0,
                line: 1.35,
                tracking: -0.012,
                above: 1.6,
            },
            3 => Self {
                size: 17.0,
                line: 1.35,
                tracking: -0.012,
                above: 1.4,
            },
            _ => Self {
                size: BODY_SIZE,
                line: 1.35,
                tracking: -0.012,
                above: 1.4,
            },
        }
    }

    /// Its top margin: its room above it less the column's gap (none
    /// first, less after another heading).
    fn margin_top(&self, before: Before) -> f32 {
        let above = match before {
            Before::Nothing => return 0.0,
            Before::Heading => 0.6,
            Before::Block => self.above,
        };
        (self.size * above - BLOCK_GAP).max(0.0)
    }
}

/// The width in rems below which a table column stops shrinking (and the
/// table scrolls): about half its content, so long text wraps to two lines
/// or so, clamped to 10 to 30 rems so a huge column cannot push the scroll
/// threshold arbitrarily far; a narrower column keeps its content width
/// plus room for the cells' padding, so it never wraps. The content is
/// estimated from the cells' text, as text is measured on the platforms.
fn column_floor<'a>(cells: impl Iterator<Item = &'a super::TableCell>) -> f32 {
    const MIN: f32 = 10.0;
    const MAX: f32 = 30.0;
    const PADDING: f32 = 2.0;
    let content = cells
        .map(|cell| {
            let mut text = String::new();
            super::document::inline_text(&cell.content, &mut text);
            text.lines().map(text_width).fold(0.0, f32::max)
        })
        .fold(0.0, f32::max);
    (content + PADDING).min((content / 2.0).clamp(MIN, MAX))
}

/// The width of `line` in ems, estimated: wide (East Asian) characters
/// are an em, spaces a third, the rest a little over half.
fn text_width(line: &str) -> f32 {
    line.chars()
        .map(|c| match c as u32 {
            0x20 => 0.3,
            0x1100..=0x115f
            | 0x2e80..=0xa4cf
            | 0xac00..=0xd7a3
            | 0xf900..=0xfaff
            | 0xfe30..=0xfe4f
            | 0xff00..=0xff60
            | 0xffe0..=0xffe6
            | 0x1f300..=0x1faff
            | 0x20000..=0x3fffd => 1.0,
            _ => 0.6,
        })
        .sum()
}

/// The built-in copy action's icon (the gallery's copy glyph), which fades
/// and shrinks away as a check springs in once `done` goes to 1.
fn copy_icon(done: &AnimatedValue) -> AnyElement {
    let muted = theme().muted_foreground;
    let ok = theme().foreground;
    // The gallery's copy and check glyphs, drawn on a 20 unit grid scaled
    // to the icon's 14 pt.
    const K: f32 = 14.0 / 20.0;
    let polyline = |painter: Painter, points: &[f32]| {
        let mut painter = painter.begin_path().move_to(points[0] * K, points[1] * K);
        for p in points[2..].chunks(2) {
            painter = painter.line_to(p[0] * K, p[1] * K);
        }
        painter.stroke()
    };
    let pen = |painter: Painter, c| {
        painter
            .stroke_style(c)
            .line_width(1.6 * K)
            .line_cap(nsh_core::canvas::LineCap::Round)
            .line_join(nsh_core::canvas::LineJoin::Round)
    };
    let sheets = canvas(move || {
        let painter = pen(Painter::new(), color(muted))
            .begin_path()
            .round_rect(
                bounds(
                    point(px(7.0 * K), px(7.0 * K)),
                    size(px(10.0 * K), px(10.0 * K)),
                ),
                px(2.5 * K),
            )
            .stroke();
        polyline(
            painter,
            &[
                13.0, 4.5, 13.0, 4.0, 12.0, 3.0, 4.0, 3.0, 3.0, 4.0, 3.0, 12.0, 4.0, 13.0, 4.5,
                13.0,
            ],
        )
    });
    let check = canvas(move || {
        polyline(
            pen(Painter::new(), color(ok)),
            &[4.5, 10.5, 8.5, 14.0, 15.5, 6.0],
        )
    });
    let layer = |v: View| v.absolute().inset(px(0.0));
    view()
        .size(px(14.0))
        .child(
            layer(view())
                .bind_opacity(&done.interpolate(&[0.0, 1.0], &[1.0, 0.0]))
                .bind_scale(&done.interpolate(&[0.0, 1.0], &[1.0, 0.4]))
                .child(sheets.size(px(14.0))),
        )
        .child(
            layer(view())
                .bind_opacity(&done.interpolate(&[0.0, 1.0], &[0.0, 1.0]))
                .bind_scale(&done.interpolate(&[0.0, 1.0], &[0.4, 1.0]))
                .child(check.size(px(14.0))),
        )
        .into_element()
}

/// The text color that reads on background `bg`: near black on a light
/// color, near white on a dark one (by relative luminance).
fn ink_on(bg: Hsla) -> Hsla {
    let c = nsh_core::color::Rgba::from(bg);
    let lin = |v: f32| {
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let luminance = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    if luminance > 0.18 {
        rgb(0x1f1e1c).into()
    } else {
        rgb(0xf4f3f0).into()
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{Percentage, Points};

    use super::*;

    fn image(src: &str) -> Inline {
        Inline::Image(Image::new(src))
    }

    #[test]
    fn content_of_images_alone_is_shown_as_blocks() {
        let link = |content| Inline::Link {
            url: "https://x.y".into(),
            title: None,
            content,
        };
        let content = [image("a.png"), link(vec![image("b.png")])];
        let images = only_images(&content).unwrap();
        let found: Vec<_> = images
            .iter()
            .map(|(i, l, _)| (i.src.as_str(), *l))
            .collect();
        assert_eq!(found, [("a.png", None), ("b.png", Some("https://x.y"))]);
        // Text, even a space, puts the images in its lines, as gpui-kit's
        // text flow does.
        assert!(only_images(&[image("a.png"), Inline::text(" "), image("b.png")]).is_none());
        assert!(only_images(&[link(vec![image("a.png"), Inline::text("x")])]).is_none());
        assert!(only_images(&[]).is_none());
    }

    #[test]
    fn images_in_text_are_sized_as_gpui_kits_flow_sizes_them() {
        let pt = |p: f32| Some(ImageLength::Points(Points(p)));
        let size = |w: f32, h: f32| Size::new(px(w), px(h));
        let line = 24.0;
        // Both given.
        assert_eq!(
            inline_image_size(pt(32.0), pt(20.0), Some(2.0), line),
            size(32.0, 20.0)
        );
        // One given: the other from the aspect ratio, a line until known.
        assert_eq!(
            inline_image_size(pt(40.0), None, Some(2.0), line),
            size(40.0, 20.0)
        );
        assert_eq!(
            inline_image_size(pt(40.0), None, None, line),
            size(40.0, 24.0)
        );
        assert_eq!(
            inline_image_size(None, pt(10.0), Some(2.0), line),
            size(20.0, 10.0)
        );
        assert_eq!(
            inline_image_size(None, pt(10.0), None, line),
            size(10.0, 10.0)
        );
        // Neither: three quarters of the line tall.
        assert_eq!(
            inline_image_size(None, None, Some(2.0), line),
            size(36.0, 18.0)
        );
        assert_eq!(inline_image_size(None, None, None, line), size(18.0, 18.0));
        // A percentage is of the line's height.
        let half = Some(ImageLength::Fraction(Percentage(0.5)));
        assert_eq!(inline_image_size(half, half, None, line), size(12.0, 12.0));
        // Never below a point.
        assert_eq!(
            inline_image_size(pt(0.0), pt(0.0), None, line),
            size(1.0, 1.0)
        );
    }

    /// Render props take closures of the value they render, events their
    /// data, as the setters of other props take their values (built, not
    /// run: an element is made in a component's reactive scope; the core's
    /// tests render a render prop set so).
    #[test]
    fn builds_with_render_closures_and_listeners() {
        let _build = || {
            text_view()
                .markdown("# Title")
                .selectable(true)
                .render_image(|context: &TextViewImageContext| text(context.image.alt.clone()))
                .render_code_block(|code: &CodeBlock| text(code.code.clone()))
                .on_link_press(|_event: &TextViewLinkPressEvent| {})
                .into_element()
        };
    }
    #[component]
    fn LinksAcrossReplacement() -> impl IntoElement {
        let source = signal(SharedString::from("[same](file.txt)"));
        let first = signal(None::<TextViewLinkTarget>);
        let presses = signal(0);
        let status = signal(String::from("ready"));
        view()
            .flex_col()
            .child(
                view()
                    .test_id("replace")
                    .h(px(30.0))
                    .on_press(move || source.set("[same][ref]\n\n[ref]: file.txt".into())),
            )
            .child(view().test_id("kind").h(px(30.0)).on_press(move || {
                source.set(format!("{}\n---", source.get_untracked()).into());
            }))
            .child(view().test_id("old").h(px(30.0)).on_press(move || {
                status.set(format!(
                    "old {}",
                    first
                        .get_untracked()
                        .is_some_and(|target| target.focus_native())
                ))
            }))
            .child(text(move || status.get()))
            .child(
                text_view()
                    .source_id("message")
                    .markdown(move || Some(source.get()))
                    .on_link_press(move |event: &TextViewLinkPressEvent| {
                        let target = event.target.clone().expect("original Link capability");
                        first.set(Some(target.clone()));
                        presses.update(|n| *n += 1);
                        status.set(format!(
                            "press {} focus {}",
                            presses.get_untracked(),
                            target.focus_native()
                        ));
                    }),
            )
    }

    #[test]
    fn a_same_value_link_after_source_replacement_has_a_new_live_focus_capability() {
        use nsh_core::{Size, element::Root};
        use nsh_testing::Headless;
        let mut app = Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(500.0), px(400.0)),
            ..nsh_engine::EngineConfig::new(Root::of::<LinksAcrossReplacement>())
        })
        .unwrap();
        app.wait_for("text:same").unwrap();
        app.press("text:same").unwrap();
        app.wait_for("press 1 focus true").unwrap();
        // Prefix append keeps the source but changes this row's kind.
        app.press("id:kind").unwrap();
        app.wait_for("role:header").unwrap();
        app.press("id:old").unwrap();
        app.wait_for("old false").unwrap();
        app.press("text:same").unwrap();
        app.wait_for("press 2 focus true").unwrap();
        app.press("id:replace").unwrap();
        app.wait_for("text:same").unwrap();
        app.press("id:old").unwrap();
        app.wait_for("old false").unwrap();
        app.press("text:same").unwrap();
        app.wait_for("press 3 focus true").unwrap();
        let node = app.screen().press_target("text:same").unwrap().unwrap();
        assert!(
            app.screen()
                .commands()
                .iter()
                .any(|(id, command)| *id == node && matches!(command, nsh_core::Command::Focus))
        );
    }

    #[component]
    fn DocumentViewportChoices() -> impl IntoElement {
        let page = element_ref();
        let source_id = signal(SharedString::from("first"));
        let target = signal(None::<TextViewLinkTarget>);
        let status = signal(String::from("ready"));
        let presses = signal(0);
        let source = format!(
            "```text\ncode kept across recycling\n```\n\n<details><summary>Disclosure</summary>\n\ndisclosed child\n\n</details>\n\n[saved link](file.txt)\n\n{}\n\nviewport tail",
            (0..80)
                .map(|i| format!("filler {i}\n\n"))
                .collect::<String>(),
        );
        view()
            .flex_col()
            .flex_1()
            .child(
                view()
                    .test_id("bottom")
                    .h(px(25.0))
                    .on_press(move || page.scroll_to_end(false)),
            )
            .child(view().test_id("top").h(px(25.0)).on_press(move || {
                page.scroll_to(point(px(0.0), px(0.0)), false);
            }))
            .child(view().test_id("old-link").h(px(25.0)).on_press(move || {
                status.set(format!(
                    "link live {}",
                    target
                        .get_untracked()
                        .is_some_and(|target| target.is_live())
                ));
            }))
            .child(
                view()
                    .test_id("reset")
                    .h(px(25.0))
                    .on_press(move || source_id.set("second".into())),
            )
            .child(text(move || status.get()))
            .child(
                scroll().flex_1().element_ref(&page).child(
                    text_view()
                        .markdown(source)
                        .source_id(move || Some(source_id.get()))
                        .code_block_actions(vec![TextViewCodeAction {
                            id: "wrap".into(),
                            label: Some("Wrap code".into()),
                        }])
                        .on_link_press(move |event: &TextViewLinkPressEvent| {
                            target.set(event.target.clone());
                            presses.update(|value| *value += 1);
                            status.set(format!("link pressed {}", presses.get_untracked()));
                        }),
                ),
            )
    }

    #[test]
    fn document_viewport_recycles_link_owners_and_retains_source_choices() {
        use nsh_core::{Size, element::Root};
        use nsh_testing::Headless;
        let mut app = Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(500.0), px(500.0)),
            ..nsh_engine::EngineConfig::new(Root::of::<DocumentViewportChoices>())
        })
        .unwrap();
        app.wait_for("label:Wrap code").unwrap();
        let first_wrap = app
            .screen()
            .press_target("label:Wrap code")
            .unwrap()
            .unwrap();
        let first_details = app
            .screen()
            .press_target("text:Disclosure")
            .unwrap()
            .unwrap();
        assert!(app.screen().selected("label:Wrap code").unwrap());
        app.press("label:Wrap code").unwrap();
        assert!(!app.screen().selected("label:Wrap code").unwrap());
        app.press("text:Disclosure").unwrap();
        app.wait_for("disclosed child").unwrap();
        app.press("text:saved link").unwrap();
        app.wait_for("link pressed 1").unwrap();
        app.press("id:bottom").unwrap();
        app.wait_for("viewport tail").unwrap();
        // Detached cells keep their last logical content until reused. A
        // larger viewport binds the middle rows as well, reusing those cells.
        app.set_viewport(Size::new(px(500.0), px(1800.0))).unwrap();
        app.wait_for("filler 30").unwrap();
        app.press("id:old-link").unwrap();
        app.wait_for("link live false").unwrap();
        app.set_viewport(Size::new(px(500.0), px(500.0))).unwrap();
        app.press("id:top").unwrap();
        app.wait_for("label:Wrap code").unwrap();
        assert!(!app.screen().selected("label:Wrap code").unwrap());
        assert_ne!(
            app.screen()
                .press_target("label:Wrap code")
                .unwrap()
                .unwrap(),
            first_wrap
        );
        assert_ne!(
            app.screen()
                .press_target("text:Disclosure")
                .unwrap()
                .unwrap(),
            first_details
        );
        app.wait_for("disclosed child").unwrap();
        app.press("text:saved link").unwrap();
        app.wait_for("link pressed 2").unwrap();
        app.press("id:old-link").unwrap();
        app.wait_for("link live true").unwrap();
        app.press("id:reset").unwrap();
        app.wait_for("label:Wrap code").unwrap();
        assert!(app.screen().selected("label:Wrap code").unwrap());
        assert!(!app.screen().shows("disclosed child"));
    }
}
